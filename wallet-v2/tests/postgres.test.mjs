import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { PostgresLedgerStore } from '../store.mjs';
import { createWalletV2Service } from '../service.mjs';
import { WALLET_HISTORY_START } from '../gavin.mjs';
const connection = process.env.WALLET_V2_TEST_DATABASE_URL;
if (!connection || !/^postgres(?:ql)?:\/\/[^/]+@(?:127\.0\.0\.1|localhost):55439\//.test(connection)) throw Error('Tests require the dedicated local V2 PostgreSQL container');

test('daily query cache survives a real PostgreSQL reconnect without RPC or a new revision', async () => {
  const firstStore = new PostgresLedgerStore(connection), wallet = '0x' + randomBytes(20).toString('hex');
  let readerCount = 0, secondStore;
  const now = () => Date.parse('2026-11-24T10:00:00Z');
  try {
    await firstStore.initialize();
    const service = createWalletV2Service({ store: firstStore, now, logger: { info() {}, error() {} },
      catalogLoader: async () => ({ pools: [], cards: {}, unsupported: [] }),
      readerFactory: () => { readerCount++; return { stats: { units: 20 }, batch: async () => [],
        rpc: async method => method === 'eth_chainId' ? '0x2105'
          : { number: '0x' + (WALLET_HISTORY_START + 1).toString(16), hash: 'isolated-cache-test', timestamp: '0x6b03eba3' } }; },
      gavinScanner: async (_reader, _wallet, from, to) => ({ from, to, events: [], warnings: [] }) });
    const fresh = await service.query(wallet); await firstStore.close();
    secondStore = new PostgresLedgerStore(connection);
    const restarted = createWalletV2Service({ store: secondStore, now, logger: { info() {}, error() {} },
      readerFactory: () => { throw Error('cached query must not construct an RPC reader'); } });
    const cached = await restarted.query(wallet);
    assert.equal(readerCount, 1); assert.equal(cached.usage.units, 0); assert.equal(cached.usage.cacheHit, true);
    assert.deepEqual(cached.ledger, fresh.ledger);
    assert.equal((await secondStore.load(wallet)).revision, fresh.ledger.revision);
  } finally {
    if (!firstStore.pool.ended) await firstStore.close(); await secondStore?.close();
  }
});
test('actual PostgreSQL transaction persists events and rolls back a stale revision; views survive new connection', async () => {
  const store = new PostgresLedgerStore(connection);
  const wallet = '0x' + randomBytes(20).toString('hex'), id = randomBytes(16).toString('hex');
  try {
    await store.initialize();
    const empty = await store.load(wallet);
    const first = await store.save(wallet, 0, { ...empty, events: [{ id: 'receipt:1', block: 55066201, timestamp: 1794211092,
      category: 'UpgradeRequested', raw: null }], coverage: { upgrade: { through: 55066201, complete: false } } });
    assert.deepEqual(await store.load(wallet), first);
    await assert.rejects(store.save(wallet, 0, { ...first, events: [], coverage: {} }), /revision conflict/);
    assert.deepEqual(await store.load(wallet), first);
    const originalView = await store.saveView({ id, ownerId: 'test-owner', wallet, selection: { scope: 'upgrade' } });
    const view = await store.saveView({ ...originalView, selection: { scope: 'all' } }, originalView.revision);
    const second = new PostgresLedgerStore(connection);
    try { assert.deepEqual(await second.load(wallet), first); assert.deepEqual(await second.loadView(id), view); }
    finally { await second.close(); }
    await assert.rejects(store.saveView({ ...view, ownerId: 'other' }, 0), /revision conflict/);
    await assert.rejects(store.saveView({ id: randomBytes(16).toString('hex'), ownerId: 'test-owner' }, 5), /revision conflict/);
  } finally { await store.close(); }
});

test('large saves preserve unchanged tuples and a later failed batch rolls the entire checkpoint back', async () => {
  const store = new PostgresLedgerStore(connection), wallet = '0x' + randomBytes(20).toString('hex');
  try {
    await store.initialize();
    const events = Array.from({ length: 1200 }, (_, i) => ({ id: `event:${i}`, block: i + 1, logIndex: i % 5,
      timestamp: 1794211092 + i, proof: 'proof-'.repeat(500), category: 'test' }));
    const first = await store.save(wallet, 0, { ...await store.load(wallet), events });
    const tuples = () => store.pool.query('SELECT id,xmin::text FROM wallet_v2_events WHERE wallet=$1 ORDER BY id', [wallet]);
    const before = (await tuples()).rows;
    const second = await store.save(wallet, first.revision, first);
    assert.deepEqual((await tuples()).rows, before, 'an unchanged event must not create a new MVCC tuple');
    assert.deepEqual(await store.load(wallet), second);
    const broken = [...events, { id: 'invalid-last-batch', block: 99999, timestamp: 'invalid bigint' }];
    await assert.rejects(store.save(wallet, second.revision, { ...second, events: broken }), /bigint/);
    assert.deepEqual(await store.load(wallet), second, 'all earlier batches and the head revision must roll back');
    const changed = structuredClone(second); changed.events[5].proof = 'corrected';
    await store.save(wallet, second.revision, changed);
    const after = (await tuples()).rows;
    assert.equal(after.filter((row, i) => row.xmin !== before[i].xmin).length, 1);
  } finally { await store.close(); }
});

test('a checked-out PostgreSQL client can disconnect without an unhandled error or loss of later connections', async () => {
  const errors = [], store = new PostgresLedgerStore(connection, { logger: { error: (...args) => errors.push(args) } });
  let client;
  try {
    await store.initialize(); client = await store.pool.connect();
    const { rows } = await client.query('SELECT pg_backend_pid() AS pid');
    const disconnected = new Promise(resolve => client.once('error', resolve));
    await store.pool.query('SELECT pg_terminate_backend($1)', [rows[0].pid]);
    await disconnected;
    client.release(true); client = null;
    assert.ok(errors.some(row => row[0] === 'postgres_connection_error'));
    assert.deepEqual((await store.load('0x' + '1'.repeat(40))).events, []);
  } finally { client?.release(true); await store.close(); }
});
