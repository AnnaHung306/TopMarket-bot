import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { upgradeDefinition } from '../registry.mjs';
import { decodeUpgradeLog, receiptTransfers, upgradeSpins } from '../upgrade.mjs';
import { buildReport, textReport } from '../report.mjs';
import { csvReport, htmlReport } from '../exports.mjs';
import { assetKey, dateRange, taipeiDay, eventId, money } from '../model.mjs';
import { STAKE } from '../../worker/index.js';
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
  assert.equal(report.metrics.find(metric => metric.key === 'upgradeValue').raw, null);
  assert.match(textReport(report), /卡牌升級活動價差：待確認/);
  assert.match(csvReport(report), /"upgrade".*"165000000".*"210000000"/);
  assert.equal(report.upgrade.laterProceedsRaw, null);
  assert.equal(buildReport(ledger, { scope: 'all' }).siteSummary.find(row => row.key === 'buyback').raw, null);
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
  assert.equal(report.upgrade.realizedPnlRaw, '170000000');
  assert.match(textReport(report), /💎 卡牌升級活動價差：45\.00 USDC/);
  assert.doesNotMatch(textReport(report), /已實現收益/);
  assert.equal(report.realized[0].originPoolId, originPool.id);
});
test('holdings separate checked wallet, staking and unverified ownership, with costs kept out of cash CSV fields', () => {
  const ledger = withAcquisition(sampleLedger());
  const known = buildReport(ledger);
  assert.equal(known.holdingsSummary.walletCount, 1);
  assert.equal(known.holdingsSummary.knownCostRaw, '80000000');
  assert.equal(known.upgrade.laterProceedsRaw, '0');
  assert.doesNotMatch(textReport(known), /回購／出售入帳|後續收入/);
  assert.doesNotMatch(textReport(known), /已實現收益|尚未實現/);
  assert.match(csvReport(known), /"holding"/);
  const csv = csvReport(known).replace(/^\ufeff/, '').split('\r\n').map(row => row.slice(1, -1).split('","'));
  const holdingRow = csv.find(row => row[0] === 'holding');
  assert.equal(holdingRow[csv[0].indexOf('raw_usdc')], '');
  assert.equal(holdingRow[csv[0].indexOf('acquisition_expenditure_raw')], '80000000');
  const stake = { id: 'stake-transfer', kind: 'nft', collection: request148.targetCollection, tokenId: request148.targetTokenId,
    tx: '0x' + '8'.repeat(64), block: request148.block + 100, logIndex: 2, timestamp: request148.timestamp + 200, from: wallet, to: STAKE };
  ledger.transfers.push(stake);
  ledger.events.push({ ...stake, id: 'stake-event', legacyId: stake.tx + ':0x1', category: 'staked', logIndex: 1 });
  const staked = buildReport(ledger, { scope: 'staking', detail: 'detail' });
  assert.equal(staked.holdingsSummary.walletCount, 0);
  assert.equal(staked.holdingsSummary.stakedCount, 1);
  assert.equal(staked.holdingsSummary.knownCostRaw, '80000000');
  assert.match(textReport(staked), /參考價值：待確認/);
  assert.match(textReport(staked), /🃏 持倉明細/);
  ledger.ownershipCoverage = {};
  const uncertain = buildReport(ledger);
  assert.equal(uncertain.holdingsSummary.stakedCount, 0);
  assert.equal(uncertain.holdingsSummary.unverifiedCount, 1);
  assert.match(textReport(uncertain), /參考價值：待確認/);
});

test('upgrade-only stored evidence requests acquisition history instead of implying a complete profit report', () => {
  const ledger = sampleLedger();
  ledger.coverage[pool.id].complete = true;
  const report = buildReport(ledger, { scope: 'upgrade' });
  assert.equal(report.complete, false);
  assert.equal(report.upgrade.referenceChangeRaw, '45000000');
  assert.equal(report.upgrade.laterProceedsRaw, null);
  assert.equal(report.upgrade.incomePendingReason, '買賣紀錄待補齊');
  assert.equal(buildReport(ledger, { scope: 'all' }).siteSummary.find(row => row.key === 'buyback').raw, null);
});

test('a newer upgrade checkpoint cannot turn older sale history into a known zero', () => {
  const ledger = withAcquisition(sampleLedger());
  ledger.coverage.gavin.through = request148.block - 1;
  ledger.coverage[pool.id].through = request148.block + 100;
  const report = buildReport(ledger, { scope: 'upgrade' });
  assert.equal(report.complete, false);
  assert.equal(report.upgrade.laterProceedsRaw, null);
  assert.equal(report.upgrade.incomePendingReason, '買賣紀錄待更新');
});

test('zero income with an unsold upgraded card differs from a sale with unknown cost', () => {
  const unsold = buildReport(withAcquisition(sampleLedger()), { scope: 'upgrade' });
  assert.equal(unsold.complete, true);
  assert.equal(unsold.upgrade.incomePendingReason, null);
  assert.doesNotMatch(textReport(unsold), /回購／出售入帳|後續收入/);
  assert.match(textReport(unsold), /卡牌升級活動價差：45\.00 USDC/);
  const ledger = withSale(withAcquisition(sampleLedger()));
  ledger.ownershipCoverage = {};
  const unknownCost = buildReport(ledger, { scope: 'upgrade' });
  assert.equal(unknownCost.upgrade.laterProceedsRaw, '250000000');
  assert.doesNotMatch(textReport(unknownCost), /升級回購入帳：250\.00 USDC/);
  assert.doesNotMatch(textReport(unknownCost), /已實現收益/);
});

test('a winning settlement with missing or incompatible price precision is unknown, never zero', async () => {
  for (const valueDecimals of [undefined, 18]) {
    const ledger = withAcquisition(sampleLedger());
    ledger.events.find(event => event.category === 'UpgradeRequested').valueDecimals = valueDecimals;
    const report = buildReport(ledger, { scope: 'upgrade' });
    assert.equal(report.upgrade.won, 1);
    assert.equal(report.metrics.find(metric => metric.key === 'upgradeValue').raw, null);
    assert.match(textReport(report), /卡牌升級活動價差：待確認/);
    assert.match(await htmlReport(report), /data-key="upgradeValue" data-raw="unknown"[^>]*><span>卡牌升級活動價差<\/span><strong>待確認<\/strong>/);
  }
});

test('verified no activity is zero; a failed upgrade deducts its stake and pending spins do not', () => {
  const failed = withAcquisition(sampleLedger('144'));
  assert.equal(buildReport(failed, { scope: 'upgrade' }).metrics.find(metric => metric.key === 'upgradeValue').raw, '-45000000');
  failed.events = []; failed.transfers = [];
  assert.equal(buildReport(failed, { scope: 'upgrade' }).metrics.find(metric => metric.key === 'upgradeValue').raw, '0');
  const pending = withAcquisition(sampleLedger());
  pending.events = pending.events.filter(event => event.category === 'UpgradeRequested');
  assert.equal(buildReport(pending, { scope: 'upgrade' }).metrics.find(metric => metric.key === 'upgradeValue').raw, '0');
});

test('poster embeds the official logo offline and leaves emoji to text headings and field labels', async () => {
  const report = buildReport(withSale(withAcquisition(sampleLedger())), { detail: 'detail' });
  const html = await htmlReport(report);
  assert.match(html, /<img class="brand" src="data:image\/svg\+xml;base64,/);
  assert.doesNotMatch(html, /\p{Extended_Pictographic}/u);
  assert.doesNotMatch(html, /<div class="brand">TOP\.MARKET/);
  assert.doesNotMatch(html, /已實現收益|USDC 估值|data-key="realized"/);
  assert.match(html, /data-key="upgradeValue" data-raw="45000000"[^>]*><span>卡牌升級活動價差<\/span><strong>45\.00<\/strong>/);
  const svg = Buffer.from(/data:image\/svg\+xml;base64,([^"]+)/.exec(html)[1], 'base64').toString();
  assert.equal(svg, await readFile(new URL('../../assets/top-market-logo.svg', import.meta.url), 'utf8'));
  assert.doesNotMatch(svg, /<script|<image|href=/i);
  const text = textReport(report);
  assert.match(text, /\*\*⬆️ 升級明細\*\*\n#148/);
  assert.match(text, /\*\*🔎 交易證據\*\*\n[+-]/);
  assert.doesNotMatch(text, /收益分類|卡池收益|持倉成本/);
  assert.match(text, /市場買卡：|市場賣卡：/);
  assert.doesNotMatch(text, /🎮|✅|❌|👛/u);
  assert.equal((text.match(/卡牌升級活動價差：/g) || []).length, 1);
});
test('report menus and compact text use consistent category emoji without changing the three-state controls', () => {
  const ledger = withAcquisition(sampleLedger());
  for (const detail of ['summary', 'detail']) {
    const text = textReport(buildReport(ledger, { detail }));
    assert.ok(text.length < 1900);
    assert.match(text, detail === 'summary' ? /📊 簡要報表/ : /📋 詳細報表/);
    const rows = viewComponents(ledger, { id: '1'.repeat(32), revision: 1, phase: 'draft', selection: { scope: 'all', period: 'all', detail } }).map(row => row.toJSON());
    const buttons = rows.flatMap(row => row.components).filter(c => c.type === 2);
    assert.equal(buttons.find(b => b.label === (detail === 'summary' ? '詳細報表' : '收合明細')).emoji.name, detail === 'summary' ? '📋' : '🔽');
    assert.equal(buttons.find(b => b.label === '更新資料').emoji.name, '🔄');
    assert.ok(buttons.find(b => b.label === '下載 PNG').disabled);
    assert.ok(rows[0].components[0].options.every(o => o.emoji?.name));
  }
});

test('Gavin report fields replace activity partitions in both text and poster', async () => {
  const ledger = withSale(withAcquisition(sampleLedger()));
  for (const detail of ['summary', 'detail']) {
    const report = buildReport(ledger, { scope: 'all', detail });
    assert.equal(report.siteSummary.length, 8);
    assert.equal(report.siteSummary.find(row => row.key === 'pack').raw, '80000000');
    assert.equal(report.siteSummary.find(row => row.key === 'sales').raw, '250000000');
    const text = textReport(report), html = await htmlReport(report);
    for (const row of report.siteSummary) {
      assert.ok(text.includes(row.label)); assert.ok(html.includes('data-key="' + row.key + '"'));
    }
    assert.doesNotMatch(text, /CSV|已實現收益|各項收支|持倉成本|卡池收益/);
    assert.match(text, /市場賣卡：250\.00/);
    assert.doesNotMatch(text, /升級回購入帳：250\.00|回購／出售入帳：250\.00/);
    assert.equal((html.match(/class="poster glass"/g) || []).length, 1);
    assert.ok(text.length < 1900);
  }
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
  assert.equal(components.length, 2);
  assert.deepEqual(components[0].toJSON().components[0].options.map(option => option.value), ['all', '7d', '30d', 'month', 'custom']);
  assert.ok(!walletV2Command.toJSON().options.some(option => option.name === 'scope'));
});
