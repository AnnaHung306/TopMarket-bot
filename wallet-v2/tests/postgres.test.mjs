import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { PostgresLedgerStore } from '../store.mjs';
const connection = process.env.WALLET_V2_TEST_DATABASE_URL;
if (!connection || !/^postgres(?:ql)?:\/\/[^/]+@(?:127\.0\.0\.1|localhost):55439\//.test(connection)) throw Error('Tests require the dedicated local V2 PostgreSQL container');
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
