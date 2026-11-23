import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { uniqueDrawForWin, verifyAdapterAcquisitions } from '../acquisition-evidence.mjs';
import { upgradeDefinition } from '../registry.mjs';
import { decodeUpgradeLog, receiptTransfers } from '../upgrade.mjs';
import { buildReport } from '../report.mjs';
import { eventId, USDC, word } from '../model.mjs';
import { cashFlows } from '../gavin.mjs';
const acquisition = JSON.parse(await readFile(new URL('../fixtures/public-acquisition.json', import.meta.url)));
const manifest = JSON.parse(await readFile(new URL('../contracts/blind-box-acquisition.manifest.json', import.meta.url)));
const publicDraw = acquisition.events.find(e => e.category === 'pack'), publicWin = acquisition.events.find(e => e.category === 'won');
test('actual namespaced source proof binds its draw, source and unique outcome', () => {
  assert.equal(uniqueDrawForWin(acquisition.events, publicWin)?.id, publicDraw.id);
  for (const mutation of [draw => { draw.randomnessSource = '0x' + '1'.repeat(40); },
    draw => { draw.adapterEvidence.drawEventId = 'another-draw'; }, draw => { draw.adapterEvidence.winEventId = 'another-win'; },
    draw => { draw.adapterEvidence.verified = false; }]) {
    const events = structuredClone(acquisition.events); mutation(events.find(e => e.category === 'pack'));
    assert.equal(uniqueDrawForWin(events, events.find(e => e.category === 'won')), null);
  }
  const duplicate = structuredClone(publicDraw); duplicate.id += ':other-source'; duplicate.randomnessSource = '0x' + '1'.repeat(40);
  assert.equal(uniqueDrawForWin([...acquisition.events, duplicate], publicWin), null, 'same request ID in a second source must not be joined by ID alone');
});
function proofReader({ wrongPlayer = false, wrongImplementation = false } = {}) {
  const proof = publicDraw.adapterEvidence;
  const recorded = new Map(proof.blocks.map((block, index) => [block, proof.responses[index]]));
  return { stats: { splits: 0 }, rpc: async method => { assert.equal(method, 'eth_getLogs'); return []; },
    batch: async calls => calls.map(([method, params]) => {
      if (method === 'eth_getStorageAt') return word(proof.beacon);
      const [call, at] = params;
      if (call.to === proof.beacon) return word(wrongImplementation ? '0x' + '1'.repeat(40) : manifest.implementation);
      assert.ok(call.data.startsWith(manifest.selector + word(publicDraw.randomnessSource).slice(2)));
      let response = recorded.get(Number(at)); assert.ok(response);
      if (wrongPlayer && Number(at) !== proof.blocks.at(-1)) response = word('0x' + '1'.repeat(40)) + response.slice(66);
      return response;
    }) };
}
test('historical sourceRequestOf evidence re-verifies player, net payment, request time and clearing', async () => {
  const ledger = { wallet: '0x' + publicDraw.adapterEvidence.responses[0].slice(26, 66),
    events: structuredClone(acquisition.events), coverage: { gavin: { complete: true } } };
  // The proof stores player in the historical return data, not in transaction sender or a relayer.
  delete ledger.events.find(e => e.category === 'pack').adapterEvidence;
  await verifyAdapterAcquisitions(proofReader(), ledger);
  assert.equal(ledger.events.find(e => e.category === 'pack').adapterEvidence.verified, true);
  for (const option of [{ wrongPlayer: true }, { wrongImplementation: true }]) {
    const copy = structuredClone(ledger); delete copy.events.find(e => e.category === 'pack').adapterEvidence;
    await verifyAdapterAcquisitions(proofReader(option), copy);
    assert.equal(copy.events.find(e => e.category === 'pack').adapterEvidence.verified, false);
  }
});
test('multiple requests share block reads and one beacon timeline without sharing namespaced request state', async () => {
  const events = structuredClone(acquisition.events);
  const draw = events.find(e => e.category === 'pack'), win = events.find(e => e.category === 'won');
  delete draw.adapterEvidence;
  events.push({ ...structuredClone(draw), id: draw.id + ':second', requestId: (BigInt(draw.requestId) + 1n).toString() },
    { ...structuredClone(win), id: win.id + ':second', requestId: (BigInt(draw.requestId) + 1n).toString(), winId: win.winId + '1' });
  const calls = [], base = proofReader(); let timelines = 0;
  const reader = { ...base, rpc: async (...args) => { timelines++; return base.rpc(...args); },
    batch: async batch => { calls.push(...batch); return base.batch(batch); } };
  const ledger = { wallet: '0x' + publicDraw.adapterEvidence.responses[0].slice(26, 66), events, coverage: { gavin: { complete: true } } };
  await verifyAdapterAcquisitions(reader, ledger);
  assert.ok(events.filter(e => e.category === 'pack').every(e => e.adapterEvidence.verified));
  assert.equal(calls.filter(([method]) => method === 'eth_getStorageAt').length, 2);
  assert.equal(calls.filter(([method, params]) => method === 'eth_call' && params[0].data === '0x5c60da1b').length, 2);
  const namespaced = calls.filter(([method, params]) => method === 'eth_call' && params[0].data.startsWith(manifest.selector));
  assert.equal(new Set(namespaced.map(([, params]) => params[0].data)).size, 2);
  assert.equal(timelines, 1);
});
test('an interrupted proof batch saves completed evidence and resumes only unfinished requests', async () => {
  const events = [];
  for (let i = 0; i < 201; i++) {
    const requestId = (BigInt(publicDraw.requestId) + BigInt(i)).toString();
    const draw = { ...structuredClone(publicDraw), id: publicDraw.id + ':' + i, requestId };
    delete draw.adapterEvidence;
    events.push(draw, { ...structuredClone(publicWin), id: publicWin.id + ':' + i, requestId, winId: String(i) });
  }
  const ledger = { wallet: '0x' + publicDraw.adapterEvidence.responses[0].slice(26, 66), events, coverage: { gavin: { complete: true } } };
  const base = proofReader(); let saved, sourceCalls = 0;
  const reader = { ...base, batch: async calls => {
    sourceCalls += calls.filter(([, params]) => params[0]?.data?.startsWith(manifest.selector)).length;
    if (sourceCalls > 600) throw Error('simulated transient interruption');
    return base.batch(calls);
  } };
  await assert.rejects(verifyAdapterAcquisitions(reader, ledger, null, async () => { saved = structuredClone(ledger); }), /interruption/);
  assert.equal(saved.events.filter(e => e.adapterEvidence?.verified).length, 200);
  assert.equal(saved.events.find(e => e.id === publicDraw.id + ':200').adapterEvidence.version, undefined);
  let resumedCalls = 0;
  await verifyAdapterAcquisitions({ ...base, batch: calls => { resumedCalls += calls.length; return base.batch(calls); } }, saved);
  assert.equal(saved.events.filter(e => e.adapterEvidence?.verified).length, 201);
  assert.equal(resumedCalls, 7);
});

const upgradeFixture = JSON.parse(await readFile(new URL('../fixtures/public-upgrades.json', import.meta.url)));
const definition = await upgradeDefinition(), pool = { ...definition, definition, supported: true };
const times = new Map(upgradeFixture.blocks.map(block => [Number(block.number), Number(block.timestamp)]));
function chainScenario({ checked = true } = {}) {
  const events = upgradeFixture.receipts.flatMap(receipt => receipt.logs.filter(log => log.address === pool.address)
    .map(log => decodeUpgradeLog(log, pool)).filter(Boolean)).filter(e => ['147', '148'].includes(e.spinId))
    .map(e => ({ ...e, timestamp: times.get(e.block), valueDecimals: 6 }));
  const first = events.find(e => e.category === 'UpgradeRequested' && e.spinId === '147');
  const last = events.find(e => e.category === 'UpgradeRequested' && e.spinId === '148');
  const wallet = first.player, tx = '0x' + 'a'.repeat(64), saleTx = '0x' + 'b'.repeat(64), box = '0x' + 'c'.repeat(40);
  const block = first.block - 10, timestamp = first.timestamp - 30;
  events.push({ id: 'scenario-draw', legacyId: tx + ':0x1', tx, block, logIndex: 1, timestamp, category: 'pack', contract: box,
    raw: '100000000', activity: 'packs', requestId: '1', packKind: 'card', paymentVerified: true, sourceStatus: 'legacy-receipt' },
  { id: 'scenario-won', legacyId: tx + ':0x2', tx, block, logIndex: 2, timestamp, category: 'won', contract: box,
    requestId: '1', winId: '1', collection: first.stakeCollection, tokenId: first.stakeTokenId, raw: null },
  { id: 'scenario-kept', legacyId: tx + ':0x3', tx, block, logIndex: 3, timestamp, category: 'kept', contract: box,
    winId: '1', collection: first.stakeCollection, tokenId: first.stakeTokenId, raw: null,
    acquisitionVerified: true, nftReceiptId: tx + ':0x4' },
  { id: 'scenario-sale', legacyId: saleTx + ':0x2', tx: saleTx, block: last.block + 30, logIndex: 2, timestamp: last.timestamp + 60,
    category: 'sales', activity: 'market', contract: USDC, raw: '250000000', saleIds: [saleTx + ':0x3'] },
  { id: 'scenario-sale-gross', legacyId: saleTx + ':0x3', tx: saleTx, block: last.block + 30, logIndex: 3, timestamp: last.timestamp + 60,
    category: 'saleGross', activity: 'market', contract: '0xf20658ec88403e9a26d77fb95e91c1248d9818ea', raw: '250000000',
    collection: last.targetCollection, tokenId: last.targetTokenId });
  const txs = new Set(events.filter(e => e.activity === 'upgrade').map(e => e.tx));
  const transfers = upgradeFixture.receipts.filter(receipt => txs.has(receipt.transactionHash)).flatMap(receipt => receiptTransfers(receipt, wallet))
    .map(t => ({ ...t, timestamp: times.get(t.block) }));
  transfers.push({ id: eventId(tx, 4), tx, block, timestamp, logIndex: 4, kind: 'nft', from: box, to: wallet,
    collection: first.stakeCollection, tokenId: first.stakeTokenId },
  { id: eventId(saleTx, 1), tx: saleTx, block: last.block + 30, timestamp: last.timestamp + 60, logIndex: 1, kind: 'nft',
    from: wallet, to: '0x' + 'd'.repeat(40), collection: last.targetCollection, tokenId: last.targetTokenId });
  return { version: 1, wallet, events, transfers, catalog: [pool, { id: `pack:${box}`, kind: 'packs', address: box, name: 'Scenario pack' }],
    cards: {}, warnings: [], asOf: '2026-11-23T00:00:00Z',
    coverage: { gavin: { status: 'verified', complete: true }, [pool.id]: { status: 'verified', complete: true } },
    ownershipCoverage: checked ? Object.fromEntries(transfers.map(t => [t.collection, last.block + 1000])) : {} };
}
test('two actual upgrade outcomes in a synthetic acquisition/sale scenario carry expenditure exactly once', () => {
  const report = buildReport(chainScenario(), { scope: 'all' });
  assert.equal(report.upgrade.requests, 2); assert.equal(report.upgrade.referenceChangeRaw, '130000000');
  assert.equal(report.cash.netRaw, '150000000');
  assert.equal(report.realizedSummary.knownPnlRaw, '150000000');
  assert.equal(report.realized[0].costRaw, '100000000');
  assert.equal(report.upgrade.laterProceedsRaw, '250000000');
});
test('receipt-observed holdings cannot establish a realized expenditure result without full continuity', () => {
  const report = buildReport(chainScenario({ checked: false }), { scope: 'all' });
  assert.equal(report.realized[0].pnlRaw, null);
  assert.match(report.realized[0].reason, /持有歷史/);
});
test('upgrade-pool filtering retains later sale lineage, while other scopes do not leak upgrade rows', () => {
  const report = buildReport(chainScenario(), { scope: 'upgrade', poolId: pool.id });
  assert.equal(report.cash.netRaw, '0', 'the upgrade itself is an NFT exchange');
  assert.equal(report.upgrade.laterProceedsRaw, '250000000');
  assert.equal(report.realizedSummary.knownPnlRaw, '150000000');
  assert.equal(buildReport(chainScenario(), { scope: 'market' }).upgrade.spins.length, 0);
});
test('a duplicate USDC transfer is counted once, self-trades are excluded, nominal purchases stay unresolved', () => {
  const wallet = '0x' + '1'.repeat(40), tx = '0x' + '2'.repeat(64), market = '0xf20658ec88403e9a26d77fb95e91c1248d9818ea';
  const base = { tx, block: 1, logIndex: 1, timestamp: 1, contract: USDC, raw: '10000000', activity: 'market' };
  const events = [{ ...base, id: 'sale', category: 'sales' }, { ...base, id: 'staking-alias', activity: 'staking', category: 'staking-treasury' },
    { ...base, id: 'self', logIndex: 2, category: 'selfTrade' }, { ...base, id: 'purchase', logIndex: 3, contract: market,
      category: 'purchaseGross', currency: USDC, raw: '100000000' }];
  const result = cashFlows(events, [], wallet, []);
  assert.equal(result.flows.length, 1); assert.equal(result.flows[0].raw, '10000000');
  assert.equal(result.pending.length, 1); assert.equal(result.pending[0].category, 'purchaseGross');
});
