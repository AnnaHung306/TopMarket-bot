import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { upgradeDefinition, verifyUpgradeVersion } from '../registry.mjs';
import { decodeUpgradeLog, receiptTransfers, upgradeSpins } from '../upgrade.mjs';
import { verifyUpgradeRecycles } from '../upgrade-recycle.mjs';
import { buildReport, textReport } from '../report.mjs';
import { eventId, assetKey, USDC } from '../model.mjs';

const fixture = JSON.parse(await readFile(new URL('../fixtures/public-upgrade-recycles.json', import.meta.url)));
const definition = await upgradeDefinition(), pool = { ...definition, definition, supported: true };
const times = new Map(fixture.blocks.map(block => [Number(block.number), Number(block.timestamp)]));
const receipts = new Map(fixture.receipts.map(receipt => [receipt.transactionHash, receipt]));
const wallet = '0x5ac570565f4037d76708f3d95066763021f43e58';
function recordedReader({ token, receiptChange } = {}) {
  return { batch: async calls => calls.map(([method, params]) => {
    if (method === 'eth_getTransactionReceipt') {
      const receipt = structuredClone(receipts.get(params[0])); receiptChange?.(receipt); return receipt;
    }
    if (token && params[0].data === definition.selectors.settlementToken) return '0x' + token.slice(2).padStart(64, '0');
    const getter = fixture.getters.find(row => row.params[0].data === params[0].data && Number(row.params[1]) === Number(params[1]));
    if (!getter) throw Error('Unexpected fixture getter');
    return getter.result;
  }) };
}
async function ledger(options) {
  const events = fixture.receipts.flatMap(receipt => receipt.logs.filter(log => log.address === pool.address)
    .map(log => decodeUpgradeLog(log, pool)).filter(Boolean))
    .map(event => ({ ...event, timestamp: times.get(event.block), ...(event.category === 'UpgradeRequested' ? { valueDecimals: 6 } : {}) }));
  await verifyUpgradeRecycles(recordedReader(options), events, pool);
  return { version: 1, wallet, events, transfers: fixture.receipts.flatMap(receipt => receiptTransfers(receipt, wallet))
    .map(transfer => ({ ...transfer, timestamp: times.get(transfer.block) })), catalog: [pool], cards: {}, warnings: [],
    coverage: { gavin: { status: 'verified', complete: true }, [pool.id]: { status: 'verified', complete: true } },
    asOf: new Date(Math.max(...times.values()) * 1000).toISOString() };
}

test('actual V2 spins 149/150 pay 157.50 USDC each; cash is counted with payment evidence and never invented basis', async () => {
  const data = await ledger(), report = buildReport(data, { scope: 'upgrade', detail: 'detail' });
  assert.deepEqual(report.upgrade.spins.map(spin => spin.request.spinId), ['149', '150']);
  assert.ok(report.upgrade.spins.every(spin => spin.delivery === 'recycled'));
  assert.equal(report.upgrade.awaitingChoice, 0);
  assert.equal(report.cash.inRaw, '315000000');
  assert.equal(report.upgrade.laterProceedsRaw, '315000000');
  assert.equal(report.upgrade.realizedCount, 2); assert.equal(report.upgrade.realizedPnlRaw, null);
  assert.equal(report.upgrade.unknownCostCount, 2); assert.equal(report.holdings.length, 0);
  assert.ok(report.flows.every(flow => flow.proofIds.length === 1 && flow.verification === 'receipt-matched'));
  assert.match(textReport(report), /已回購入帳/);
  const summary = buildReport(data, { scope: 'all' });
  assert.equal(summary.siteSummary.find(row => row.key === 'buyback').raw, '315000000');
  assert.match(textReport(summary), /回購收入：315\.00/);
  assert.doesNotMatch(textReport(summary), /升級回購入帳/);
  assert.doesNotMatch(textReport(report), /已實現收益|成本待確認/);
});

test('verified recycle retains the original acquisition cost and overrides duplicate generic treasury attribution', async () => {
  const data = await ledger();
  for (const [index, request] of data.events.filter(event => event.category === 'UpgradeRequested').entries()) {
    const tx = '0x' + String(index + 1).repeat(64), market = '0xf20658ec88403e9a26d77fb95e91c1248d9818ea';
    const base = { tx, block: request.block - 1, timestamp: request.timestamp - 2, logIndex: 3 };
    data.events.push({ ...base, id: 'synthetic-purchase-' + index, category: 'purchaseGross', activity: 'market',
      contract: market, currency: USDC, raw: '80000000', collection: request.stakeCollection, tokenId: request.stakeTokenId });
    data.transfers.push({ ...base, id: eventId(tx, 1), logIndex: 1, kind: 'usdc', raw: '80000000', collection: USDC, from: wallet, to: market },
      { ...base, id: eventId(tx, 2), logIndex: 2, kind: 'nft', collection: request.stakeCollection,
        tokenId: request.stakeTokenId, from: market, to: wallet });
  }
  data.ownershipCoverage = Object.fromEntries(data.transfers.filter(t => t.kind === 'nft').map(t => [t.collection, 62000000]));
  for (const recycle of data.events.filter(event => event.category === 'WinRecycled')) {
    const payment = data.transfers.find(t => t.id === recycle.recycleTransferId);
    data.events.unshift({ ...payment, id: payment.id + ':staking-treasury', category: 'staking-treasury', activity: 'staking',
      legacyId: payment.id, contract: USDC });
  }
  const report = buildReport(data);
  assert.equal(report.cash.inRaw, '315000000'); assert.equal(report.cash.outRaw, '160000000');
  assert.equal(report.siteSummary.find(row => row.key === 'buyback').raw, '315000000');
  assert.equal(report.siteSummary.find(row => row.key === 'staking').raw, '0');
  assert.equal(report.upgrade.realizedPnlRaw, '155000000');
  assert.equal(report.realizedSummary.knownCount, 2); assert.equal(report.realizedSummary.unknownCostCount, 0);
  assert.equal(report.holdings.length, 0);
});

test('a missing or contradictory recycle transfer stays unknown; a non-USDC settlement is never mixed into USDC', async () => {
  for (const options of [
    { receiptChange: receipt => { receipt.logs = receipt.logs.filter(log => log.address !== USDC); } },
    { token: '0x' + 'a'.repeat(40) },
  ]) {
    const report = buildReport(await ledger(options), { scope: 'upgrade' });
    assert.equal(report.upgrade.laterProceedsRaw, null);
    assert.equal(report.upgrade.incomePendingReason, '回購入帳待核對');
    assert.equal(report.pending.length, 2);
    assert.ok(report.upgrade.spins.every(spin => spin.delivery === 'payout-unverified'));
    assert.equal(buildReport(await ledger(options)).siteSummary.find(row => row.key === 'buyback').raw, null);
  }
});

test('synthetic equal-value batch payouts bind one physical transfer to each spin without ambiguity or reuse', async () => {
  const data = await ledger(), recycles = data.events.filter(event => event.category === 'WinRecycled');
  const tx = recycles[0].tx, historicalBlock = recycles[0].block;
  const receipt = structuredClone(receipts.get(tx)), transfer = receipt.logs.find(log => log.address === USDC);
  receipt.logs = recycles.flatMap((event, index) => [
    { ...transfer, transactionHash: tx, logIndex: '0x' + (index * 2 + 1).toString(16) },
    { ...event.rawLog, transactionHash: tx, logIndex: '0x' + (index * 2 + 2).toString(16) },
  ]);
  recycles.forEach((event, index) => {
    event.tx = tx; event.block = historicalBlock; event.logIndex = index * 2 + 2;
    event.raw = null; delete event.recycleVerified; delete event.recycleTransferId;
  });
  const underlying = recordedReader();
  const reader = { batch: calls => calls[0][0] === 'eth_getTransactionReceipt' ? [receipt] : underlying.batch(calls) };
  await verifyUpgradeRecycles(reader, recycles, pool);
  assert.deepEqual(recycles.map(event => event.recycleTransferId), [eventId(tx, 1), eventId(tx, 3)]);
  assert.ok(recycles.every(event => event.raw === '157500000' && event.recycleVerified));
});

test('a real winning settlement awaiting choice is not an NFT holding or a received payment', async () => {
  const data = await ledger(); data.events = data.events.filter(event => event.category !== 'WinRecycled');
  const report = buildReport(data, { scope: 'upgrade', detail: 'detail' });
  assert.equal(report.upgrade.won, 2); assert.equal(report.upgrade.awaitingChoice, 2);
  assert.equal(report.holdings.length, 0); assert.equal(report.cash.inRaw, '0');
  assert.match(textReport(report), /待選擇留卡或回購 2/);
});

test('synthetic keep resolution locates delivery in the keep transaction, not in the winning settlement', async () => {
  const data = await ledger();
  const request = data.events.find(event => event.category === 'UpgradeRequested');
  data.events = data.events.filter(event => event.spinId === request.spinId && event.category !== 'WinRecycled');
  const tx = '0x' + 'f'.repeat(64), block = request.block + 1000, timestamp = request.timestamp + 2000;
  data.events.push({ id: 'synthetic-keep', category: 'WinKept', activity: 'upgrade', poolId: pool.id, contract: pool.address,
    spinId: request.spinId, player: wallet, tx, block, logIndex: 1, timestamp });
  data.transfers.push({ id: eventId(tx, 2), tx, block, logIndex: 2, timestamp, kind: 'nft', from: pool.address, to: wallet,
    collection: request.targetCollection, tokenId: request.targetTokenId });
  const spin = upgradeSpins(data.events, data.transfers, wallet)[0];
  assert.equal(spin.delivery, 'delivered'); assert.equal(spin.deliveryTransferId, eventId(tx, 2));
  const report = buildReport(data, { scope: 'upgrade' });
  assert.equal(report.upgrade.awaitingChoice, 0);
  assert.equal(assetKey(report.holdings[0].collection, report.holdings[0].tokenId), assetKey(request.targetCollection, request.targetTokenId));
});

test('unknown implementations and known-address runtime mismatches remain rejected', async () => {
  const version = definition.versions[0];
  const reader = { stats: { splits: 0 }, rpc: async method => method === 'eth_getStorageAt'
    ? '0x' + version.implementation.slice(2).padStart(64, '0') : method === 'eth_getCode' ? '0x01' : [] };
  await assert.rejects(verifyUpgradeVersion(reader, pool, version.activationBlock, version.activationBlock + 1), /bytecode 尚未核實/);
});
