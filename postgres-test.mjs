import assert from 'node:assert/strict';
import { postgresSql } from './worker/history/store.js';

const calls = [];
let released = false, fail = false;
const client = {
  async query(text, values) {
    calls.push([text, values]);
    if (fail && text.startsWith('INSERT')) throw Error('test failure');
    return { rows: [{ ok: true }] };
  },
  release() { released = true; },
};
const pool = { ...client, async connect() { return client; } };
const sql = postgresSql(pool);
assert.deepEqual(await sql`SELECT ${'test'} AS value`, [{ ok: true }]);
assert.deepEqual(calls.shift(), ['SELECT $1 AS value', ['test']]);
await sql.transaction([sql`SELECT ${1}`, sql`INSERT INTO test VALUES (${2})`]);
assert.deepEqual(calls.map(([text]) => text), ['BEGIN', 'SELECT $1', 'INSERT INTO test VALUES ($1)', 'COMMIT']);
assert.equal(released, true);
calls.length = 0; released = false; fail = true;
await assert.rejects(sql.transaction([sql`INSERT INTO test VALUES (${3})`]), /test failure/);
assert.deepEqual(calls.map(([text]) => text), ['BEGIN', 'INSERT INTO test VALUES ($1)', 'ROLLBACK']);
assert.equal(released, true);
console.log('Postgres adapter tests passed');
