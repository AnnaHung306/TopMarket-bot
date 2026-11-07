import { addr, decode, decodeReward, MARKET, SIG, STAKE, USDC, word } from '../index.js';
import { activeAuction, compactLog, evidencePlan, getFilteredLogs, receiptRecord } from './chain.js';

const logId = log => log.transactionHash + ':' + log.logIndex;
const MAX_ACTIVITY_WINDOW = 4_096;
const MIN_ACTIVITY_TRANSACTIONS = 6;

function nearbyActivityWindows(candidates) {
  const ordered = [...candidates].sort(([, a], [, b]) => a - b);
  const windows = [];
  let end = 0;
  for (let start = 0; start < ordered.length;) {
    const from = ordered[start][1];
    while (end < ordered.length && ordered[end][1] - from < MAX_ACTIVITY_WINDOW) end++;
    if (end - start < MIN_ACTIVITY_TRANSACTIONS) {
      start++;
      continue;
    }
    windows.push({ from, to: ordered[end - 1][1], hashes: new Set(ordered.slice(start, end).map(([tx]) => tx)) });
    start = end;
  }
  return windows;
}

export async function walletEvidence(reader, wallet, logs, cash, soldCards, addresses, cardAddresses, history, from, to) {
  const recipient = word(wallet);
  const sources = new Set(addresses);
  const draws = [...logs.values()].filter(log => log.topics[0] === SIG.draw);
  const byTx = new Map();
  function addProof(log) {
    const group = byTx.get(log.transactionHash) ?? new Map();
    group.set(logId(log), log);
    byTx.set(log.transactionHash, group);
  }
  cash.forEach(addProof);

  const lookup = new Set(soldCards.map(item => item.hash));
  const batchCandidates = new Map(soldCards.filter(item => history.audited(Number(item.blockNum)))
    .map(item => [item.hash, Number(item.blockNum)]));
  const kept = new Map();
  const expected = new Map();
  for (const log of logs.values()) {
    const signature = log.topics[0];
    if (signature === SIG.kept) {
      const block = Number(log.blockNumber);
      lookup.add(log.transactionHash);
      kept.set(log.transactionHash, block);
      if (history.audited(block)) batchCandidates.set(log.transactionHash, block);
    }
    const claims = signature === SIG.refund || signature === SIG.rescue ? [decode(log)] : decodeReward(log, wallet);
    const amounts = expected.get(log.transactionHash) ?? [];
    for (const claim of claims) if (BigInt(claim.raw) > 0n) amounts.push(claim.raw);
    if (amounts.length) expected.set(log.transactionHash, amounts);
  }
  const paid = new Set();
  for (const [tx, group] of byTx) {
    const block = Number(group.values().next().value.blockNumber);
    const audited = history.audited(block);
    const inbound = [...group.values()].filter(log => log.topics[0] === SIG.transfer && log.topics[2] === recipient &&
      BigInt(log.data) > 0n && (!audited || history.payers.has(addr(log.topics[1])) || addr(log.topics[1]) === MARKET));
    if (!inbound.length) continue;
    paid.add(tx);
    const actual = inbound.map(log => BigInt(log.data).toString()).sort();
    const amounts = (expected.get(tx) ?? []).sort();
    // An unindexed staker with a positive claim either receives USDC or
    // produces PayoutDeferred in the audited implementations.
    const marketPayment = inbound.some(log => addr(log.topics[1]) === MARKET);
    const unmatched = actual.length !== amounts.length || actual.some((amount, index) => amount !== amounts[index]);
    if (!audited || marketPayment || unmatched) {
      if (audited && !marketPayment) batchCandidates.set(tx, block);
      else batchCandidates.delete(tx);
      lookup.add(tx);
    }
  }

  const windows = nearbyActivityWindows(batchCandidates);
  const covered = new Set(windows.flatMap(window => [...window.hashes]));
  const activityFilter = { address: [...sources, MARKET, STAKE],
    topics: [[SIG.buyback, SIG.sold, SIG.offer, SIG.auction, SIG.kept, SIG.tokenReleased]] };
  const keptBlocks = [...kept].filter(([tx]) => covered.has(tx)).map(([, block]) => block);
  const hashes = [...lookup].filter(tx => !covered.has(tx));
  const [raw, deferred, requests, activity, nftTransfers] = await Promise.all([
    reader.batch(hashes.map(hash => ['eth_getTransactionReceipt', [hash]])),
    addresses.length ? getFilteredLogs(reader, { address: addresses, topics: [SIG.payoutDeferred, recipient] }, from, to) : [],
    draws.length ? getFilteredLogs(reader, {
      address: [...new Set(draws.map(log => log.address))],
      topics: [SIG.requestVia, [...new Set(draws.map(log => log.topics[1]))]],
    }, from, to) : [],
    Promise.all(windows.map(async ({from, to, hashes}) => {
      const found = await getFilteredLogs(reader, activityFilter, from, to);
      return found.filter(log => hashes.has(log.transactionHash));
    })),
    keptBlocks.length ? getFilteredLogs(reader, { topics: [SIG.transfer, null, recipient] },
      Math.min(...keptBlocks), Math.max(...keptBlocks)) : [],
  ]);
  [...deferred, ...requests].forEach(addProof);
  for (const log of nftTransfers) {
    if (log.topics.length === 4 && kept.has(log.transactionHash) && covered.has(log.transactionHash)) addProof(log);
  }
  const extra = [...new Set(deferred.map(log => log.transactionHash).filter(tx => paid.has(tx) && !lookup.has(tx)))];
  raw.push(...await reader.batch(extra.map(hash => ['eth_getTransactionReceipt', [hash]])));
  hashes.push(...extra);
  const records = new Map(hashes.map((tx, index) => [tx, receiptRecord(tx, raw[index])]));
  function addActivity(entry) {
    const address = entry.address.toLowerCase(), signature = entry.topics[0];
    if (address === STAKE && signature === SIG.tokenReleased) {
      addProof(compactLog(entry));
      return;
    }
    if (signature === SIG.kept && cardAddresses.has(address) && history.audited(Number(entry.blockNumber)) &&
      /^0x[0-9a-f]{64}$/i.test(entry.data) && BigInt(entry.data) > 0n) {
      const proof = byTx.get(entry.transactionHash);
      if (proof && [...proof.values()].some(log => log.address === USDC && log.topics[0] === SIG.transfer &&
        log.topics[2] === recipient && log.data === entry.data)) {
        const log = compactLog(entry);
        logs.set(logId(log), { ...log, dispositionCandidate: true });
      }
    }
    if ((sources.has(address) && signature === SIG.buyback) ||
      (address === MARKET && ([SIG.sold, SIG.offer].includes(signature) || activeAuction(entry)))) {
      const log = compactLog(entry);
      logs.set(logId(log), log);
    }
  }
  raw.forEach(receipt => receipt.logs.forEach(addActivity));
  activity.forEach(group => group.forEach(addActivity));
  for (const tx of evidencePlan([...logs.values()], true).receipts) {
    if (records.has(tx)) continue;
    // Canonical finalized logs are emitted by successful transactions. Supply
    // only the log types consumed by settlement, without fetching a receipt.
    records.set(tx, { tx, receipt: { status: '0x1', logs: [...(byTx.get(tx)?.values() ?? [])] } });
  }
  return [...records.values()];
}
