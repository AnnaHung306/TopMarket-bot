import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { upgradeDefinition } from '../registry.mjs';
import { decodeUpgradeLog, receiptTransfers, upgradeSpins } from '../upgrade.mjs';
import { buildReport, textReport } from '../report.mjs';
import { csvReport } from '../exports.mjs';
import { assetKey, dateRange, taipeiDay, eventId, money } from '../model.mjs';
import { viewComponents, walletV2Command } from '../discord.mjs';

const fixture = JSON.parse(await readFile(new URL('../fixtures/public-upgrades.json', import.meta.url)));
const definition = await upgradeDefinition();
const pool = { ...definition, definition, supported: true };
const blockTimes = new Map(fixture.blocks.map(block => [Number(block.number), Number(block.timestamp)]));
const rawEvents = fixture.receipts.flatMap(receipt => receipt.logs.filter(log => log.address === pool.address)
  .map(log => decodeUpgradeLog(log, pool)).filter(Boolean))
  .map(event => ({ ...event, timestamp: blockTimes.get(event.block), ...(event.category === 'UpgradeRequested' ? { valueDecimals: 6 } : {}) }));
const request148 = rawEvents.find(event => event.category === 'UpgradeRequested' && event.spinId === '148');
const wallet = request148.player;
function sampleLedger(spinId = '148') {
  const events = structuredClone(rawEvents.filter(event => event.spinId === spinId));
  const owner = events.find(event => event.category === 'UpgradeRequested').player;
  const txs = new Set(events.map(event => event.tx));
  const transfers = fixture.receipts.filter(receipt => txs.has(receipt.transactionHash)).flatMap(receipt => receiptTransfers(receipt, owner))
    .map(transfer => ({ ...transfer, timestamp: blockTimes.get(transfer.block) }));
  return { version: 1, wallet: owner, revision: 0, events, transfers, catalog: [pool], cards: {}, warnings: [],
    asOf: new Date(Math.max(...events.map(event => event.timestamp)) * 1000).toISOString(),
    coverage: { [pool.id]: { status: 'verified', complete: false, sampleOnly: true } } };
}
test('verified public spin 148: decode request, independently recompute win and confirm delivered NFT', () => {
  const ledger = sampleLedger();
  const spin = upgradeSpins(ledger.events, ledger.transfers, wallet)[0];
  assert.equal(spin.request.stakeValueRaw, '165000000');
  assert.equal(spin.request.targetValueRaw, '210000000');
  assert.equal(spin.request.chanceBps, 7228);
  assert.equal(spin.status, 'won');
  assert.equal(spin.delivery, 'delivered');
  assert.equal(spin.stakeVerified, true);
  const report = buildReport(ledger, { scope: 'upgrade' });
  assert.equal(report.cash.inRaw, '0');
  assert.equal(report.cash.outRaw, '0');
  assert.equal(report.upgrade.referenceChangeRaw, '45000000');
  assert.equal(report.complete, false, 'sample receipts must not claim complete wallet history');
  assert.match(textReport(report), /45\.00/);
  assert.match(csvReport(report), /"upgradeValue".*"45000000"/);
  assert.equal(report.upgrade.laterProceedsRaw, null);
});
test('verified public spin 144 loses; no cash outflow is invented from its 45 reference-value stake', () => {
  const ledger = sampleLedger('144');
  const report = buildReport(ledger, { scope: 'upgrade' });
  assert.equal(report.upgrade.lost, 1);
  assert.equal(report.upgrade.referenceChangeRaw, '-45000000');
  assert.equal(report.cash.netRaw, '0');
  assert.equal(report.realizedSummary.unknownCostCount, 1);
  assert.equal(report.realized[0].pnlRaw, null);
});
test('contradicting random outcome is rejected rather than silently trusting API status', () => {
  const ledger = sampleLedger();
  ledger.events.find(event => event.category === 'UpgradeSettled').won = false;
  assert.throws(() => upgradeSpins(ledger.events, ledger.transfers, wallet), /disagrees/);
});
test('pending request, rescue and deferred claim do not become failed upgrades or cash refunds', () => {
  const ledger = sampleLedger();
  ledger.events = ledger.events.filter(event => event.category === 'UpgradeRequested');
  ledger.transfers = ledger.transfers.filter(transfer => transfer.tx === request148.tx);
  assert.equal(buildReport(ledger, { scope: 'upgrade' }).upgrade.pending, 1);
  const rescued = { ...request148, id: 'test-rescue', category: 'UpgradeRescued', block: request148.block + 10,
    logIndex: 1, timestamp: request148.timestamp + 20, tx: '0x' + 'd'.repeat(64) };
  ledger.events.push(rescued, { ...rescued, id: 'test-claimable', category: 'CardClaimable', logIndex: 2 });
  let report = buildReport(ledger, { scope: 'upgrade' });
  assert.equal(report.upgrade.rescued, 1);
  assert.equal(report.upgrade.settled, 0);
  assert.equal(report.upgrade.claimable, 1);
  assert.equal(report.upgrade.referenceChangeRaw, '0');
  assert.equal(report.cash.inRaw, '0');
  const claim = { ...rescued, id: 'test-claimed', category: 'CardClaimed', tx: '0x' + 'e'.repeat(64), logIndex: 1, timestamp: rescued.timestamp + 5 };
  ledger.events.push(claim);
  ledger.transfers.push({ id: 'claim-nft', tx: claim.tx, block: claim.block, logIndex: 2, timestamp: claim.timestamp,
    kind: 'nft', collection: request148.stakeCollection, tokenId: request148.stakeTokenId, from: pool.address, to: wallet });
  report = buildReport(ledger, { scope: 'upgrade' });
  assert.equal(report.upgrade.spins[0].delivery, 'delivered');
  assert.equal(report.upgrade.claimable, 0);
});

const originAddress = '0x' + 'a'.repeat(40), originPool = { id: `pack:${originAddress}`, address: originAddress, name: 'Test origin pack', kind: 'packs' };
function withAcquisition(ledger) {
  ledger = structuredClone(ledger);
  const tx = '0x' + 'b'.repeat(64), block = request148.block - 10, timestamp = request148.timestamp - 30;
  ledger.catalog.push(originPool);
  ledger.coverage.gavin = { status: 'verified', complete: true };
  ledger.coverage[pool.id] = { status: 'verified', complete: true };
  ledger.ownershipCoverage = { [request148.stakeCollection]: request148.block + 1000, [request148.targetCollection]: request148.block + 1000 };
  ledger.events.unshift(
    { id: 'draw-v2', legacyId: tx + ':0x1', tx, block, logIndex: 1, timestamp, contract: originAddress, category: 'pack',
      activity: 'packs', packKind: 'card', requestId: '1', raw: '80000000', paymentVerified: true, sourceStatus: 'legacy-receipt' },
    { id: 'won-v2', legacyId: tx + ':0x2', tx, block, logIndex: 2, timestamp, contract: originAddress, category: 'won',
      requestId: '1', winId: '1', raw: null, collection: request148.stakeCollection, tokenId: request148.stakeTokenId },
    { id: 'kept-v2', legacyId: tx + ':0x3', tx, block, logIndex: 3, timestamp, contract: originAddress, category: 'kept',
      winId: '1', raw: null, acquisitionVerified: true, nftReceiptId: tx + ':0x4',
      collection: request148.stakeCollection, tokenId: request148.stakeTokenId },
  );
  ledger.transfers.push({ id: eventId(tx, 4), tx, block, logIndex: 4, timestamp, collection: request148.stakeCollection,
    tokenId: request148.stakeTokenId, from: originAddress, to: wallet, kind: 'nft' });
  return ledger;
}
function withSale(ledger, price = '250000000') {
  ledger = structuredClone(ledger);
  const tx = '0x' + 'c'.repeat(64), timestamp = request148.timestamp + 100, block = request148.block + 30;
  ledger.events.push({ id: 'sale-gross-v2', legacyId: tx + ':0x3', tx, block, logIndex: 3, timestamp,
    category: 'saleGross', activity: 'market', raw: price, contract: '0xf20658ec88403e9a26d77fb95e91c1248d9818ea',
    collection: request148.targetCollection, tokenId: request148.targetTokenId },
  { id: 'sales-v2', legacyId: tx + ':0x2', tx, block, logIndex: 2, timestamp, category: 'sales', activity: 'market',
    raw: price, contract: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', reconciled: true, saleIds: [tx + ':0x3'] });
  ledger.transfers.push({ id: eventId(tx, 1), tx, block, logIndex: 1, timestamp, kind: 'nft',
    collection: request148.targetCollection, tokenId: request148.targetTokenId, from: wallet, to: '0x' + 'f'.repeat(40) });
  return ledger;
}
test('verified acquisition expenditure follows the winning NFT; oracle values are not added to cash or basis', () => {
  const report = buildReport(withSale(withAcquisition(sampleLedger())), { scope: 'all' });
  assert.equal(report.cash.inRaw, '250000000');
  assert.equal(report.cash.outRaw, '80000000');
  assert.equal(report.cash.netRaw, '170000000');
  assert.equal(report.realized[0].costRaw, '80000000');
  assert.equal(report.realized[0].pnlRaw, '170000000');
  assert.equal(report.upgrade.referenceChangeRaw, '45000000');
  assert.equal(report.upgrade.laterProceedsRaw, '250000000');
  assert.equal(report.realized[0].originPoolId, originPool.id);
});
test('out-and-back transfers break continuity and prevent fabricated zero-cost realized profit', () => {
  const ledger = withSale(withAcquisition(sampleLedger()));
  const base = { collection: request148.stakeCollection, tokenId: request148.stakeTokenId, kind: 'nft', tx: '0x' + '9'.repeat(64) };
  ledger.transfers.push({ ...base, id: 'external-out', block: request148.block - 7, logIndex: 1,
    timestamp: request148.timestamp - 20, from: wallet, to: '0x' + 'f'.repeat(40) },
  { ...base, id: 'external-back', block: request148.block - 6, logIndex: 1,
    timestamp: request148.timestamp - 19, from: '0x' + 'f'.repeat(40), to: wallet });
  const report = buildReport(ledger, { scope: 'all' });
  assert.equal(report.realized[0].pnlRaw, null);
  assert.equal(report.realizedSummary.unknownCostCount, 1);
});
test('origin pool perspective and transaction perspective select independently without double counting', () => {
  const ledger = withSale(withAcquisition(sampleLedger()));
  const origin = buildReport(ledger, { scope: 'all', poolId: originPool.id, dimension: 'origin' });
  const location = buildReport(ledger, { scope: 'all', poolId: originPool.id, dimension: 'location' });
  assert.equal(origin.cash.netRaw, '170000000');
  assert.equal(location.cash.netRaw, '-80000000');
  const upgradesFromPool = buildReport(ledger, { scope: 'upgrade', poolId: originPool.id, dimension: 'origin' });
  assert.equal(upgradesFromPool.upgrade.requests, 1);
});
test('Taiwan dates are validated, inclusive end dates become exclusive next-day boundaries', () => {
  assert.throws(() => taipeiDay('2026-02-29'), /無效日期/);
  assert.throws(() => dateRange({ period: 'custom', from: '2026-11-23', to: '2026-11-22' }), /起始日期/);
  const range = dateRange({ period: 'custom', from: '2026-11-21', to: '2026-11-21' });
  assert.equal(range.end - range.start, 86400);
  assert.equal(new Date(range.start * 1000).toISOString(), '2026-11-20T16:00:00.000Z');
  assert.equal(money('-1000001'), '-1.000001');
  assert.equal(money('9007199254740993000000'), '9,007,199,254,740,993.00');
});
test('unsupported activity is unknown; current bot remains unregistered and pool menus stay valid', () => {
  const ledger = sampleLedger(); ledger.coverage[pool.id] = { status: 'unsupported', reason: 'Unknown implementation' };
  const report = buildReport(ledger, { scope: 'upgrade' });
  assert.equal(report.complete, false);
  assert.equal(report.metrics.find(metric => metric.key === 'upgradeValue').raw, null);
  assert.equal(walletV2Command.toJSON().name, 'wallet');
  for (let i = 0; i < 80; i++) ledger.catalog.push({ id: 'pack:' + i, kind: 'packs', name: 'Closed pack ' + i, address: originAddress, enabled: false });
  const components = viewComponents(ledger, { id: '1'.repeat(32), selection: { scope: 'all', period: 'all', poolId: 'pack:79', detail: 'summary' }, poolPage: 0 });
  assert.equal(components.length, 5);
  assert.ok(components[1].toJSON().components[0].options.length <= 25);
  assert.ok(components[1].toJSON().components[0].options.some(option => option.value === 'pack:79' && option.default));
});
