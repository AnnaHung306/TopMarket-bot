import { neon } from '@neondatabase/serverless';
import pg from 'pg';

let pool;
export function createPostgresPool(connectionString, { logger = console } = {}) {
  const connectionPool = new pg.Pool({ connectionString });
  // pg-pool removes broken idle clients itself. Listen so that notification
  // cannot become an uncaught process error; active query rejection is unchanged.
  connectionPool.on('error', () => {
    try { logger.error?.('WALLET_DATABASE_IDLE_ERROR'); } catch { /* Diagnostics cannot crash the pool. */ }
  });
  return connectionPool;
}
export function postgresSql(connectionPool) {
  function sql(strings, ...values) {
    const text = strings.reduce((result, part, index) => result + (index ? `$${index}` : '') + part, '');
    const run = async client => (await client.query(text, values)).rows;
    return { run, then: (resolve, reject) => run(connectionPool).then(resolve, reject) };
  }
  sql.transaction = async queries => {
    const client = await connectionPool.connect();
    try {
      await client.query('BEGIN');
      const rows = [];
      for (const query of queries) rows.push(await query.run(client));
      await client.query('COMMIT');
      return rows;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  };
  return sql;
}

export function database() {
  if (!process.env.DATABASE_URL?.trim()) throw Error('DATABASE_URL is not configured');
  if (process.env.DATABASE_DRIVER === 'postgres') {
    pool ||= createPostgresPool(process.env.DATABASE_URL);
    return postgresSql(pool);
  }
  return neon(process.env.DATABASE_URL);
}

export async function initialize(sql) {
  await sql.transaction([
    sql`CREATE TABLE IF NOT EXISTS wallet_index_sources (
      address text PRIMARY KEY, kind text NOT NULL, deployment integer NOT NULL,
      through integer NOT NULL, published boolean NOT NULL DEFAULT false
    )`,
    sql`CREATE TABLE IF NOT EXISTS wallet_index_head (
      id boolean PRIMARY KEY DEFAULT true CHECK (id), block integer NOT NULL,
      hash text NOT NULL, as_of timestamptz NOT NULL, collections integer
    )`,
    sql`CREATE TABLE IF NOT EXISTS wallet_index_logs (
      tx text NOT NULL, position integer NOT NULL, block integer NOT NULL,
      source text NOT NULL REFERENCES wallet_index_sources (address),
      wallets text[] NOT NULL, log jsonb NOT NULL, PRIMARY KEY (tx, position)
    )`,
    sql`CREATE INDEX IF NOT EXISTS wallet_index_logs_wallet ON wallet_index_logs USING gin (wallets)`,
    sql`CREATE INDEX IF NOT EXISTS wallet_index_logs_source_block ON wallet_index_logs (source, block)`,
    sql`CREATE TABLE IF NOT EXISTS wallet_index_receipts (tx text PRIMARY KEY, receipt jsonb NOT NULL)`,
    sql`CREATE TABLE IF NOT EXISTS wallet_index_calls (
      source text NOT NULL, block integer NOT NULL, input text NOT NULL, result text,
      PRIMARY KEY (source, block, input)
    )`,
  ]);
}

export async function rememberSources(sql, sources) {
  if (!sources.length) return;
  await sql`INSERT INTO wallet_index_sources (address, kind, deployment, through)
    SELECT address, kind, deployment, deployment - 1
    FROM jsonb_to_recordset(${JSON.stringify(sources)}::jsonb)
      AS s(address text, kind text, deployment integer)
    ON CONFLICT (address) DO NOTHING`;
}

export function listSources(sql) {
  return sql`SELECT address, kind, deployment, through, published
    FROM wallet_index_sources ORDER BY deployment, address`;
}

export async function publishedHead(sql) {
  const [head] = await sql`SELECT block, hash, as_of, collections FROM wallet_index_head WHERE id`;
  return head;
}

export async function publish(sql, head, collections) {
  const block = Number(head.number);
  // Lock all sources in the same order as chunk writes before exposing new history.
  await sql.transaction([
    sql`SELECT address FROM wallet_index_sources ORDER BY address FOR UPDATE`,
    sql`INSERT INTO wallet_index_head (id, block, hash, as_of, collections)
      SELECT true, ${block}, ${head.hash}, ${new Date(Number(head.timestamp) * 1000).toISOString()}, ${collections}
      WHERE NOT EXISTS (SELECT 1 FROM wallet_index_sources WHERE deployment <= ${block} AND through < ${block})
      ON CONFLICT (id) DO UPDATE
        SET block = excluded.block, hash = excluded.hash, as_of = excluded.as_of, collections = excluded.collections
        WHERE wallet_index_head.block <= excluded.block`,
    sql`UPDATE wallet_index_sources SET published = true
      WHERE NOT published AND deployment <= ${block} AND through >= ${block}
        AND EXISTS (SELECT 1 FROM wallet_index_head WHERE block = ${block})
        AND NOT EXISTS (SELECT 1 FROM wallet_index_sources WHERE deployment <= ${block} AND through < ${block})`,
  ]);
}

export class HistoryChunkTooLarge extends Error {}

export async function saveChunk(sql, sources, from, to, logs, receipts, calls) {
  const encoded = [logs, receipts, calls].map(rows => JSON.stringify(rows));
  // The Neon HTTP driver serializes the JSON arguments as strings inside a second JSON envelope.
  if (Buffer.byteLength(JSON.stringify(encoded)) > 48 * 1024 * 1024) {
    throw new HistoryChunkTooLarge('Neon history chunk exceeds the safe HTTP request size');
  }
  const [logRows, receiptRows, callRows] = encoded;
  const addresses = sources.map(source => source.address).sort();
  await sql.transaction([
    sql`SELECT address FROM wallet_index_sources WHERE address = ANY(${addresses})
      ORDER BY address FOR UPDATE`,
    sql`INSERT INTO wallet_index_logs (tx, position, block, source, wallets, log)
      SELECT tx, position, block, source, wallets, log
      FROM jsonb_to_recordset(${logRows}::jsonb)
        AS r(tx text, position integer, block integer, source text, wallets text[], log jsonb)
      ON CONFLICT (tx, position) DO NOTHING`,
    sql`INSERT INTO wallet_index_receipts (tx, receipt)
      SELECT tx, receipt FROM jsonb_to_recordset(${receiptRows}::jsonb) AS r(tx text, receipt jsonb)
      ON CONFLICT (tx) DO NOTHING`,
    sql`INSERT INTO wallet_index_calls (source, block, input, result)
      SELECT source, block, input, result
      FROM jsonb_to_recordset(${callRows}::jsonb)
        AS r(source text, block integer, input text, result text)
      ON CONFLICT (source, block, input) DO NOTHING`,
    sql`UPDATE wallet_index_sources SET through = ${to}
      WHERE address = ANY(${addresses}) AND through >= ${from - 1} AND through < ${to}`,
  ]);
}

export async function receiptKeys(sql, txs) {
  return sql`SELECT tx FROM wallet_index_receipts WHERE tx = ANY(${txs})`;
}

export async function callRows(sql, keys) {
  return sql`SELECT c.source, c.block, c.input, c.result
    FROM jsonb_to_recordset(${JSON.stringify(keys)}::jsonb)
      AS r(source text, block integer, input text)
    JOIN wallet_index_calls c USING (source, block, input)`;
}
