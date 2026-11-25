import { STAKE } from '../worker/index.js';
import { RAFFLE_CONTRACT } from '../worker/history/raffle.js';
import { address, assetKey, asAddress, hex, TRANSFER, word, words, ordered } from './model.mjs';
import { cashFlows } from './gavin.mjs';
import { upgradeSpins } from './upgrade.mjs';
import { traceLineage } from './lineage.mjs';
import { createHash } from 'node:crypto';

const VERSION = 2;
const PRIZE_CLAIMED = '0xbfb36529287d5a1dcbfbbc958f0a7337a1f5bca269edc737da0be1be702f2251';
const ZERO = '0x' + '0'.repeat(40);
const call = (to, data, block) => ['eth_call', [{ to, data }, hex(block)]];
const evidenceKey = ledger => createHash('sha256').update(JSON.stringify([
  ledger.events.map(row => row.id), ledger.transfers.filter(row => row.kind === 'nft').map(row => row.id),
])).digest('hex');

export function cardValueBlock(ledger) {
  return ledger.coverage?.gavin?.status === 'verified' && ledger.coverage.gavin.complete === true && Number.isSafeInteger(ledger.coverage.gavin.through)
    ? ledger.coverage.gavin.through : null;
}
export function cardValuesFresh(ledger) {
  const block = cardValueBlock(ledger), values = ledger.cardValues;
  return block !== null && values?.version === VERSION && values.through === block &&
    values.blockHash === ledger.coverage.gavin.blockHash && values.evidenceKey === evidenceKey(ledger);
}

// Ownership and reference prices use the same fixed block as the report, as in Gavin's holdings API.
// Historical prize prices use the claim block and are never replaced by acquisition expenditure.
export async function updateCardValues(reader, ledger) {
  const through = cardValueBlock(ledger);
  if (through === null) return;
  const prizes = ledger.events.filter(event => event.category === 'raffle-card' && event.block <= through);
  const previous = ledger.cardValues || {}, prizeValues = {}, quoteCache = new Map(), oracleCache = new Map();
  const quote = (collection, tokenId, block) => {
    const key = block + ':' + assetKey(collection, tokenId);
    if (!quoteCache.has(key)) quoteCache.set(key, (async () => {
      if (!oracleCache.has(block)) oracleCache.set(block, (async () => {
        const result = await reader.rpc(...call(STAKE, '0x2630c12f', block));
        if (!/^0x[\da-f]{64}$/i.test(result)) throw Error('卡片報價 Oracle 位址回應無效');
        const oracle = asAddress(result);
        if (oracle === ZERO) return { oracle, decimals: null };
        const raw = await reader.rpc(...call(oracle, '0x05300b28', block));
        if (!/^0x[\da-f]{64}$/i.test(raw)) throw Error('卡片報價精度回應無效');
        return { oracle, decimals: Number(BigInt(raw)) };
      })());
      const { oracle, decimals } = await oracleCache.get(block);
      if (decimals !== 6) return { raw: null, oracle, decimals, block, reason: '合約報價精度尚未核實為 USDC' };
      // Verified PlatformPriceOracle ABI: priceOf(address,uint256) -> (price,updatedAt).
      const data = '0xfc3d545d' + word(collection).slice(2) + word(hex(BigInt(tokenId))).slice(2);
      const [result] = await reader.batch([call(oracle, data, block)], true);
      if (result === null) return { raw: null, oracle, decimals, block, reason: '合約沒有可讀取的卡片報價' };
      const decoded = words(result);
      if (decoded.length !== 2) throw Error('卡片報價回應格式不符');
      const raw = BigInt('0x' + decoded[0]), updatedAt = Number(BigInt('0x' + decoded[1]));
      return { raw: raw > 0n && updatedAt > 0 ? String(raw) : null, oracle, decimals, block, updatedAt,
        ...(raw === 0n || !updatedAt ? { reason: '合約尚未提供有效卡片報價' } : {}) };
    })());
    return quoteCache.get(key);
  };

  const prizeAssets = [];
  for (const event of prizes) {
    const saved = previous.prizes?.[event.id];
    if (saved?.version === VERSION && saved.transaction === event.tx && saved.block === event.block && saved.blockHash &&
      saved.blockHash === ledger.blocks?.[event.block]?.hash) {
      prizeValues[event.id] = saved;
      if (saved.collection) prizeAssets.push(saved);
      continue;
    }
    const receipt = ledger.receipts?.[event.tx] || await reader.rpc('eth_getTransactionReceipt', [event.tx]);
    if (!receipt || receipt.status !== '0x1' || Number(receipt.blockNumber) !== event.block) throw Error('奪寶卡片缺少成功領獎回執');
    if (ledger.blocks?.[event.block]?.hash && receipt.blockHash !== ledger.blocks[event.block].hash) throw Error('奪寶領獎回執區塊雜湊不符');
    const claims = receipt.logs.filter(log => address(log.address) === RAFFLE_CONTRACT && log.topics[0] === PRIZE_CLAIMED);
    const ownClaim = claims.find(log => Number(log.logIndex) === event.logIndex && asAddress(log.topics[2]) === ledger.wallet &&
      BigInt(log.topics[1]).toString() === event.requestId);
    if (!ownClaim) throw Error('奪寶領獎事件與回執不相符');
    const previousClaim = Math.max(-1, ...claims.filter(log => Number(log.logIndex) < event.logIndex).map(log => Number(log.logIndex)));
    const received = receipt.logs.filter(log => log.topics[0] === TRANSFER && log.topics.length === 4 &&
      asAddress(log.topics[1]) === RAFFLE_CONTRACT && asAddress(log.topics[2]) === ledger.wallet &&
      Number(log.logIndex) > previousClaim && Number(log.logIndex) < event.logIndex);
    if (received.length !== 1) {
      prizeValues[event.id] = { version: VERSION, transaction: event.tx, block: event.block, blockHash: receipt.blockHash,
        raw: null, reason: '奪寶獎品 NFT 尚未唯一核實' };
      continue;
    }
    const transfer = received[0], collection = address(transfer.address), tokenId = BigInt(transfer.topics[3]).toString();
    const record = { version: VERSION, transaction: event.tx, block: event.block, blockHash: receipt.blockHash, collection, tokenId,
      transferLogIndex: Number(transfer.logIndex), ...(await quote(collection, tokenId, event.block)) };
    prizeValues[event.id] = record; prizeAssets.push(record);
  }

  const snapshot = { ...ledger, events: ledger.events.filter(row => row.block <= through), transfers: ledger.transfers.filter(row => row.block <= through) };
  const cash = cashFlows(snapshot.events, snapshot.transfers, ledger.wallet, ledger.catalog);
  const lineage = traceLineage(snapshot, cash.flows, upgradeSpins(snapshot.events, snapshot.transfers, ledger.wallet));
  const candidates = [...new Map([...lineage.holdings, ...prizeAssets].map(asset => [assetKey(asset.collection, asset.tokenId), asset])).values()];
  const holdings = {};
  if (candidates.length) {
    const calls = candidates.flatMap(asset => [call(asset.collection, '0x6352211e' + word(hex(BigInt(asset.tokenId))).slice(2), through),
      call(STAKE, '0x56a0fd45' + word(asset.collection).slice(2) + word(hex(BigInt(asset.tokenId))).slice(2), through)]);
    const results = await reader.batch(calls, true);
    if (results.length !== calls.length) throw Error('卡片持有權回應不完整');
    for (const [index, asset] of candidates.entries()) {
      const parse = raw => raw === null ? null : /^0x[\da-f]{64}$/i.test(raw) ? asAddress(raw) : (() => { throw Error('卡片持有權回應格式不符'); })();
      const owner = parse(results[index * 2]), staker = parse(results[index * 2 + 1]);
      const latestTransfer = snapshot.transfers.filter(row => row.kind === 'nft' && row.collection === asset.collection && row.tokenId === asset.tokenId).sort(ordered).at(-1);
      const burned = owner === null && ledger.ownershipCoverage?.[asset.collection] >= through && latestTransfer?.to === ZERO;
      const status = owner === ledger.wallet ? 'wallet' : owner === STAKE && staker === ledger.wallet ? 'staked'
        : burned || owner && (owner !== STAKE || staker !== null && staker !== ledger.wallet) ? 'not-held' : 'unknown';
      holdings[assetKey(asset.collection, asset.tokenId)] = { collection: asset.collection, tokenId: asset.tokenId, owner, staker, status,
        ...(burned ? { burnTransferId: latestTransfer.id } : {}),
        ...(status === 'wallet' || status === 'staked' ? await quote(asset.collection, asset.tokenId, through) : { raw: null, block: through }) };
    }
  }
  ledger.cardValues = { version: VERSION, through, blockHash: ledger.coverage.gavin.blockHash, evidenceKey: evidenceKey(ledger),
    asOf: ledger.coverage.gavin.asOf, prizes: prizeValues, holdings,
    unresolvedAssets: Object.values(prizeValues).filter(record => !record.collection).length };
}

export function raffleReferenceValue(ledger, events) {
  const prizes = events.filter(event => event.category === 'raffle-card');
  if (!prizes.length) return '0';
  let total = 0n;
  for (const event of prizes) {
    const record = ledger.cardValues?.prizes?.[event.id];
    if (record?.version !== VERSION || record.block !== event.block || record.transaction !== event.tx || record.raw == null ||
      ledger.blocks?.[event.block]?.hash && record.blockHash !== ledger.blocks[event.block].hash) return null;
    total += BigInt(record.raw);
  }
  return String(total);
}

export function holdingsReferenceValue(ledger) {
  if (!cardValuesFresh(ledger) || ledger.cardValues.unresolvedAssets) return null;
  let total = 0n;
  for (const record of Object.values(ledger.cardValues.holdings)) {
    if (record.status === 'not-held') continue;
    if (record.status === 'unknown' || record.raw == null) return null;
    total += BigInt(record.raw);
  }
  return String(total);
}
