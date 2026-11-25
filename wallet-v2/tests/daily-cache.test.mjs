import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { FileLedgerStore } from '../store.mjs';
import { createWalletV2Service } from '../service.mjs';
import { WALLET_HISTORY_START } from '../gavin.mjs';
import { freshForDay, localDay, reportAsOf } from '../freshness.mjs';
import { testDirectory } from './helpers/directory.mjs';

const directory = testDirectory('daily-cache');
const wallet = () => '0x' + randomBytes(20).toString('hex');
const quiet = { info() {}, error() {} };
function setup(options = {}) {
  let time = Date.parse('2026-11-24T10:00:00Z'), readers = 0, scans = 0, writes = 0, failure = false;
  const store = new FileLedgerStore(directory), save = store.save.bind(store);
  store.save = (...args) => { writes++; return save(...args); };
  const settings = { store, now: () => time, logger: quiet,
    catalogLoader: async () => ({ pools: [], cards: {}, unsupported: [] }),
    readerFactory: () => {
      readers++; const head = WALLET_HISTORY_START + readers;
      return { stats: { units: 20, requests: 2, retries: 0, splits: 0, methods: {} }, batch: async () => [],
        rpc: async method => {
          if (failure) throw Error('provider unavailable');
          if (method === 'eth_chainId') return '0x2105';
          return { number: '0x' + head.toString(16), hash: 'stable-fixture-hash', timestamp: '0x' + Math.floor(time / 1000).toString(16) };
        } };
    },
    gavinScanner: async (_reader, _wallet, from, to) => { scans++; await options.scanHook?.(); return { from, to, events: [], warnings: [] }; },
  };
  return { store, service: createWalletV2Service(settings), restart: () => createWalletV2Service({ ...settings, store: new FileLedgerStore(directory) }),
    setTime: value => { time = Date.parse(value); }, fail: value => { failure = value; },
    get readers() { return readers; }, get scans() { return scans; }, get writes() { return writes; } };
}

test('same-day persisted cache uses zero RPC, zero writes, including after service restart', async () => {
  const h = setup(), id = wallet();
  const first = await h.service.query(id);
  assert.equal(first.usage.cacheHit, false);
  const writes = h.writes, second = await h.service.query(id), restarted = await h.restart().query(id);
  assert.deepEqual(second.ledger, first.ledger); assert.deepEqual(restarted.ledger, first.ledger);
  assert.equal(second.usage.units, 0); assert.equal(second.usage.requests, 0);
  assert.equal(restarted.usage.cacheHit, true); assert.equal(h.readers, 1); assert.equal(h.writes, writes);
});

test('explicit refresh bypasses cache, failure is reported and never substituted with stale success', async () => {
  const h = setup(), id = wallet();
  await h.service.query(id); await h.service.query(id, { force: true });
  assert.equal(h.readers, 2);
  h.fail(true);
  await assert.rejects(h.service.query(id, { force: true }), /provider unavailable/);
  h.fail(false);
  const result = await h.service.query(id, { force: true });
  assert.equal(h.readers, 4); assert.equal(result.usage.cacheHit, false);
});

test('100 simultaneous requests for the same uncached wallet share one scan', async () => {
  const h = setup(), id = wallet();
  const results = await Promise.all(Array.from({ length: 100 }, () => h.service.query(id)));
  assert.equal(h.readers, 1); assert.equal(h.scans, 1);
  assert.equal(new Set(results.map(result => result.usage.queryId)).size, 1);
});

test('an explicit refresh racing a persisted-cache read still performs a network check once', async () => {
  const h = setup(), id = wallet(); await h.service.query(id);
  const load = h.store.load.bind(h.store); let entered, release, first = true;
  const ready = new Promise(resolve => { entered = resolve; });
  h.store.load = async (...args) => {
    const value = await load(...args);
    if (first) { first = false; entered(); await new Promise(resolve => { release = resolve; }); }
    return value;
  };
  const normal = h.service.query(id); await ready;
  const manual = h.service.query(id, { force: true }); release();
  const results = await Promise.all([normal, manual]);
  assert.equal(h.readers, 2); assert.ok(results.every(result => !result.usage.cacheHit));
  assert.equal(results[0].usage.queryId, results[1].usage.queryId);
});

test('Taipei midnight refreshes only a queried wallet and does not refresh inactive wallets', async () => {
  const h = setup(), a = wallet(), b = wallet();
  h.setTime('2026-11-24T15:59:59Z');
  await h.service.query(a); await h.service.query(b);
  h.setTime('2026-11-24T16:00:00Z');
  assert.equal(h.readers, 2);
  const result = await h.service.query(a);
  assert.equal(result.usage.cacheHit, false); assert.equal(h.readers, 3);
  assert.equal(localDay((await h.store.load(b)).sourceChecks.gavin.checkedAt), '2026-11-24');
  assert.equal(localDay(result.ledger.sourceChecks.gavin.checkedAt), '2026-11-25');
});

test('a previous-day in-flight scan cannot satisfy a caller joining after midnight', async () => {
  let entered, release, first = true;
  const ready = new Promise(resolve => { entered = resolve; });
  const h = setup({ scanHook: async () => { if (first) { first = false; entered(); await new Promise(resolve => { release = resolve; }); } } });
  const id = wallet(); h.setTime('2026-11-24T15:59:59Z');
  const before = h.service.query(id); await ready;
  h.setTime('2026-11-24T16:00:01Z');
  const after = h.service.query(id); release();
  assert.equal(localDay((await before).ledger.sourceChecks.gavin.checkedAt), '2026-11-24');
  assert.equal(localDay((await after).ledger.sourceChecks.gavin.checkedAt), '2026-11-25');
  assert.equal(h.readers, 2);
});

test('partial checkpoints and pre-cache ledgers need a verified successful check', async () => {
  const h = setup(), id = wallet(), result = await h.service.query(id);
  const legacy = structuredClone(result.ledger); delete legacy.sourceChecks;
  assert.equal(freshForDay(legacy, ['gavin'], '2026-11-24'), false);
  await h.store.save(id, legacy.revision, legacy);
  await h.service.query(id); assert.equal(h.readers, 2);
  const partial = await h.store.load(id); partial.coverage.gavin.complete = false;
  assert.equal(freshForDay(partial, ['gavin'], '2026-11-24'), false);
});

test('upgrade profit obtains Gavin history once, then shares it with packs and cached upgrade queries', async () => {
  const h = setup(), id = wallet();
  await h.service.query(id, { scope: 'upgrade' });
  await h.service.query(id, { scope: 'packs' });
  const repeated = await h.service.query(id, { scope: 'upgrade' });
  assert.equal(h.scans, 1); assert.equal(h.readers, 1);
  assert.equal(repeated.usage.cacheHit, true); assert.equal(repeated.usage.units, 0);
  const ledger = await h.store.load(id);
  ledger.catalog.push({ id: 'upgrade:unknown', kind: 'upgrade' });
  assert.equal(freshForDay(ledger, ['upgrade'], '2026-11-24'), false);
  ledger.coverage['upgrade:unknown'] = { status: 'unsupported', reason: 'unverified contract' };
  assert.equal(freshForDay(ledger, ['upgrade'], '2026-11-24'), true);
});

test('a same-day old upgrade-only cache is enriched before it can satisfy a profit query', async () => {
  const h = setup(), id = wallet();
  const result = await h.service.query(id, { scope: 'upgrade' });
  const legacy = structuredClone(result.ledger);
  delete legacy.coverage.gavin; delete legacy.sourceChecks.gavin;
  await h.store.save(id, legacy.revision, legacy);
  const enriched = await h.service.query(id, { scope: 'upgrade' });
  assert.equal(enriched.usage.cacheHit, false);
  assert.equal(enriched.ledger.coverage.gavin.complete, true);
  assert.equal(h.scans, 2);
  const cached = await h.restart().query(id, { scope: 'upgrade' });
  assert.equal(cached.usage.cacheHit, true); assert.equal(cached.usage.requests, 0);
});

test('the legacy upgrade parser cache is rechecked once before accepting keep/recycle coverage', async () => {
  const h = setup(), id = wallet();
  const first = await h.service.query(id, { scope: 'upgrade' });
  const legacy = structuredClone(first.ledger); legacy.sourceChecks.upgrade.version = 1;
  await h.store.save(id, legacy.revision, legacy);
  const rechecked = await h.service.query(id, { scope: 'upgrade' });
  assert.equal(rechecked.usage.cacheHit, false); assert.equal(h.readers, 2);
  assert.equal(rechecked.ledger.sourceChecks.upgrade.version, 2);
  assert.equal(rechecked.ledger.sourceChecks.gavin.version, 1);
  assert.equal((await h.service.query(id, { scope: 'upgrade' })).usage.cacheHit, true);
});

test('mixed evidence displays its oldest relevant date rather than a newer global date', () => {
  const ledger = { asOf: '2026-11-25T01:00:00Z', catalog: [{ id: 'upgrade:a', kind: 'upgrade' }],
    coverage: { gavin: { complete: true, asOf: '2026-11-24T01:00:00Z' }, 'upgrade:a': { asOf: '2026-11-25T01:00:00Z' } } };
  assert.equal(reportAsOf(ledger, 'upgrade'), '2026-11-24T01:00:00Z');
  assert.equal(reportAsOf(ledger, 'all'), '2026-11-24T01:00:00Z');
  ledger.coverage.gavin.asOf = '2026-11-26T01:00:00Z';
  ledger.events = [{ category: 'UpgradeRequested' }];
  assert.equal(reportAsOf(ledger, 'packs'), '2026-11-25T01:00:00Z', 'cached upgrade lineage can affect holdings and realized expenditure');
});

test('an existing daily history gets valuation supplementation once without another history scan', async () => {
  const h = setup(), id = wallet();
  const result = await h.service.query(id), legacy = structuredClone(result.ledger);
  delete legacy.cardValues;
  await h.store.save(id, legacy.revision, legacy);
  const checked = await h.service.query(id);
  assert.equal(checked.usage.valuationOnly, true);
  assert.equal(h.scans, 1); assert.equal(h.readers, 2);
  assert.equal((await h.restart().query(id)).usage.requests, 0);
});
