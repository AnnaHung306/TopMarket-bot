import { addr, decodeReward, MARKET, SIG, STAKE, USDC, word } from '../index.js';
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

function repeatedTreasuryPayouts(wallet, recipient, logs, cash, history) {
  const indexedBuybacks = new Set();
  for (const log of logs.values()) {
    if (log.topics[0] !== SIG.buyback || log.topics[2] !== recipient) continue;
    const claim = decodeReward(log, wallet).find(event => event.category === 'buyback-claim');
    if (claim) indexedBuybacks.add(`${claim.tx}:${claim.logIndex - 3}:${claim.raw}`);
  }

  const groups = new Map();
  for (const log of cash) {
    if (log.address !== USDC || log.topics[0] !== SIG.transfer || log.topics[2] !== recipient) continue;
    const block = Number(log.blockNumber);
    const payer = addr(log.topics[1]);
    const raw = BigInt(log.data);
    if (raw <= 0n || payer === wallet || !history.isTreasury(payer, block) || !history.audited(block)) continue;
    const groupKey = `${log.transactionHash}:${payer}:${raw}`;
    const group = groups.get(groupKey) ?? new Map();
    group.set(logId(log), log);
    groups.set(groupKey, group);
  }

  const candidates = new Map();
  for (const group of groups.values()) {
    if (group.size < 2) continue;
    for (const log of group.values()) {
      const key = `${log.transactionHash}:${Number(log.logIndex)}:${BigInt(log.data)}`;
      if (!indexedBuybacks.has(key)) candidates.set(log.transactionHash, Number(log.blockNumber));
    }
  }
  return candidates;
}

export function readWalletDrawSources(reader, logs, from, to) {
  const draws = [...logs.values()].filter(log => log.topics[0] === SIG.draw);
  if (!draws.length) return [];
  return getFilteredLogs(reader, {
    address: [...new Set(draws.map(log => log.address))],
    topics: [SIG.requestVia, [...new Set(draws.map(log => log.topics[1]))]],
  }, from, to);
}

export function readWalletDeferredPayments(reader, wallet, addresses, from, to) {
  if (!addresses.length) return [];
  return getFilteredLogs(reader, { address: addresses, topics: [SIG.payoutDeferred, word(wallet)] }, from, to);
}

export async function walletEvidence(reader, wallet, logs, cash, soldCards, addresses, cardAddresses, history, from, to, deferred) {
  const recipient = word(wallet);
  const sources = new Set(addresses);
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
  for (const [tx, block] of repeatedTreasuryPayouts(wallet, recipient, logs, cash, history)) {
    lookup.add(tx);
    batchCandidates.set(tx, block);
  }
  const kept = new Map();
  for (const log of logs.values()) {
    if (log.topics[0] === SIG.kept) {
      const block = Number(log.blockNumber);
      lookup.add(log.transactionHash);
      kept.set(log.transactionHash, block);
      if (history.audited(block)) batchCandidates.set(log.transactionHash, block);
    }
  }
  // Market payments can identify sellers absent from wallet-indexed events.
  for (const log of cash) {
    if (log.address !== USDC || log.topics[0] !== SIG.transfer || log.topics[2] !== recipient ||
      addr(log.topics[1]) !== MARKET || BigInt(log.data) <= 0n) continue;
    batchCandidates.delete(log.transactionHash);
    lookup.add(log.transactionHash);
  }

  const windows = nearbyActivityWindows(batchCandidates);
  const covered = new Set(windows.flatMap(window => [...window.hashes]));
  const activityFilter = { address: [...sources, MARKET, STAKE],
    topics: [[SIG.buyback, SIG.sold, SIG.offer, SIG.auction, SIG.kept, SIG.tokenReleased]] };
  const keptBlocks = [...kept].filter(([tx]) => covered.has(tx)).map(([, block]) => block);
  const hashes = [...lookup].filter(tx => !covered.has(tx));
  const [raw, deferredLogs, activity, nftTransfers] = await Promise.all([
    reader.batch(hashes.map(hash => ['eth_getTransactionReceipt', [hash]])),
    deferred ?? readWalletDeferredPayments(reader, wallet, addresses, from, to),
    Promise.all(windows.map(async ({from, to, hashes}) => {
      const found = await getFilteredLogs(reader, activityFilter, from, to);
      return found.filter(log => hashes.has(log.transactionHash));
    })),
    keptBlocks.length ? getFilteredLogs(reader, { topics: [SIG.transfer, null, recipient] },
      Math.min(...keptBlocks), Math.max(...keptBlocks)) : [],
  ]);
  deferredLogs.forEach(addProof);
  for (const log of nftTransfers) {
    if (log.topics.length === 4 && kept.has(log.transactionHash) && covered.has(log.transactionHash)) addProof(log);
  }
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
  const syntheticReceipts = new Map();
  for (const tx of evidencePlan([...logs.values()], true).receipts) {
    if (records.has(tx)) continue;
    // Canonical finalized logs are emitted by successful transactions. Supply
    // only the log types consumed by settlement, without fetching a receipt.
    const receipt = { status: '0x1', logs: [...(byTx.get(tx)?.values() ?? [])] };
    syntheticReceipts.set(tx, receipt);
    records.set(tx, { tx, receipt });
  }
  return { receipts: [...records.values()], deferred: deferredLogs, syntheticReceipts };
}
