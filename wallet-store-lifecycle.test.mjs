import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createPostgresPool, postgresSql } from './worker/history/store.js';

test('idle pool error has a listener and diagnostics never expose DSN, message, stack, or an arbitrary error code', async () => {
  const logs = [], secret = 'postgresql://user:SENSITIVE_PASSWORD@127.0.0.1/database';
  const pool = createPostgresPool('postgresql://unused@127.0.0.1:1/unused', { logger: { error: (...args) => logs.push(args) } });
  try {
    assert.equal(pool.listenerCount('error'), 1);
    assert.equal(pool.emit('error', Object.assign(new Error(secret), { code: secret, stack: secret })), true);
    assert.deepEqual(logs, [['WALLET_DATABASE_IDLE_ERROR']]);
    assert.equal(JSON.stringify(logs).includes('SENSITIVE_PASSWORD'), false);
  } finally { await pool.end(); }
  const failingLogger = createPostgresPool('postgresql://unused@127.0.0.1:1/unused', { logger: { error() { throw Error('TEST ONLY logging failure'); } } });
  try { assert.equal(failingLogger.emit('error', Error(secret)), true); } finally { await failingLogger.end(); }
});

test('query failures retain the original rejection and never become an empty or successful result', async () => {
  const expected = Object.assign(new Error('TEST ONLY caller-owned query failure'), { code: 'TEST_ONLY_QUERY_FAILURE' }); let calls = 0;
  const sql = postgresSql({ async query() { calls++; throw expected; } });
  await assert.rejects(async () => sql`SELECT ${7} AS value`, error => error === expected);
  assert.equal(calls, 1);
});

test('real local PostgreSQL: terminate only this test pool idle backend, reconnect, and preserve active statement failure', {
  skip: !process.env.TEST_WALLET_LIFECYCLE_DATABASE_URL, timeout: 15_000,
}, async () => {
  const connection = process.env.TEST_WALLET_LIFECYCLE_DATABASE_URL, location = new URL(connection);
  assert.equal(location.hostname, '127.0.0.1'); assert.equal(location.port, '55432'); assert.equal(location.pathname, '/postgres');
  const logs = [], pool = createPostgresPool(connection, { logger: { error: (...args) => logs.push(args) } }), control = createPostgresPool(connection, { logger: { error() {} } });
  try {
    const idlePid = (await pool.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const controlPid = (await control.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    assert.notEqual(idlePid, controlPid); assert.equal(pool.idleCount, 1);
    const disconnected = once(pool, 'error');
    assert.equal((await control.query('SELECT pg_terminate_backend($1) AS terminated', [idlePid])).rows[0].terminated, true);
    await disconnected;
    const replacement = await pool.query('SELECT pg_backend_pid() AS pid, 1 AS value');
    assert.notEqual(replacement.rows[0].pid, idlePid); assert.equal(replacement.rows[0].value, 1); assert.deepEqual(logs, [['WALLET_DATABASE_IDLE_ERROR']]);
    await assert.rejects(pool.query('SELECT 1/0'), error => error.code === '22012');
    assert.equal(logs.length, 1, 'a failing active statement remains the caller rejection, not an idle notification');
    assert.equal((await pool.query('SELECT 1 AS value')).rows[0].value, 1);
  } finally { await Promise.allSettled([pool.end(), control.end()]); }
});
