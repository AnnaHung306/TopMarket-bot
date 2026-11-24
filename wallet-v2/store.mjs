import { mkdir, readFile, open, rename, unlink, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { address, cleanJson, ordered, SCHEMA_VERSION } from './model.mjs';
import { protectPostgresPool } from '../worker/history/pg-pool-errors.js';

const empty = wallet => ({ version: SCHEMA_VERSION, wallet, revision: 0, events: [], transfers: [], coverage: {}, catalog: [], warnings: [] });
export class FileLedgerStore {
  constructor(directory) { if (!directory) throw Error('Local ledger directory is required'); this.directory = resolve(directory); }
  path(wallet) { return join(this.directory, address(wallet) + '.json'); }
  async load(wallet) {
    try { const data = JSON.parse(await readFile(this.path(wallet), 'utf8')); if (data.version !== SCHEMA_VERSION || data.wallet !== address(wallet)) throw Error('Unsupported V2 ledger'); return data; }
    catch (error) { if (error.code === 'ENOENT') return empty(address(wallet)); throw error; }
  }
  async save(wallet, expectedRevision, ledger) {
    await mkdir(this.directory, { recursive: true });
    const target = this.path(wallet), lockPath = target + '.lock';
    const lock = await open(lockPath, 'wx').catch(error => { if (error.code === 'EEXIST') throw Error('另一個 V2 程序正在寫入此錢包'); throw error; });
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      const current = await this.load(wallet);
      if (current.revision !== expectedRevision) throw Error('V2 ledger revision conflict');
      const next = cleanJson({ ...ledger, version: SCHEMA_VERSION, wallet: address(wallet), revision: expectedRevision + 1 });
      const output = await open(temporary, 'wx');
      try { await output.writeFile(JSON.stringify(next)); await output.sync(); } finally { await output.close(); }
      await rename(temporary, target);
      return next;
    } finally {
      await lock.close(); await unlink(lockPath);
      await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }
  async loadView(id) {
    if (!/^[a-f0-9]{32}$/.test(id)) throw Error('Invalid V2 view ID');
    try { return JSON.parse(await readFile(join(this.directory, 'views', id + '.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async saveView(view, expectedRevision = 0) {
    if (!/^[a-f0-9]{32}$/.test(view.id)) throw Error('Invalid V2 view ID');
    const directory = join(this.directory, 'views');
    await mkdir(directory, { recursive: true });
    const target = join(directory, view.id + '.json'), lockPath = target + '.lock';
    const lock = await open(lockPath, 'wx').catch(error => { if (error.code === 'EEXIST') throw Error('V2 view is being updated'); throw error; });
    const temporary = join(directory, view.id + '.' + randomUUID() + '.tmp');
    try {
      const current = await this.loadView(view.id);
      if ((current?.revision ?? 0) !== expectedRevision) throw Error('V2 view revision conflict');
      const next = cleanJson({ ...view, revision: expectedRevision + 1 });
      await writeJsonFile(temporary, next);
      await rename(temporary, target);
      return next;
    } finally {
      await lock.close(); await unlink(lockPath);
      await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }
  async pendingViews() {
    const directory = join(this.directory, 'views');
    let files;
    try { files = await readdir(directory); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const views = await Promise.all(files.filter(file => /^[a-f0-9]{32}\.json$/.test(file)).map(file => this.loadView(file.slice(0, -5))));
    return views.filter(view => view && ['loading', 'draft'].includes(view.phase) && view.channelId && view.messageId);
  }
}
async function writeJsonFile(path, value) {
  const output = await open(path, 'wx');
  try { await output.writeFile(JSON.stringify(value)); await output.sync(); } finally { await output.close(); }
}

// Never obtains DATABASE_URL automatically; callers must supply an isolated V2 DB.
export class PostgresLedgerStore {
  constructor(connectionString, { allowSharedDatabase = false, allowRemote = false, logger = console } = {}) {
    if (!connectionString) throw Error('WALLET_V2_DATABASE_URL is required');
    const target = new URL(connectionString);
    if (!allowRemote && !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)) throw Error('V2 開發預設只接受本機獨立資料庫；遠端啟用須另行部署審核');
    if (!allowSharedDatabase && process.env.DATABASE_URL) {
      const current = new URL(process.env.DATABASE_URL);
      if (target.hostname === current.hostname && (target.port || '5432') === (current.port || '5432') && target.pathname === current.pathname)
        throw Error('V2 開發不可連接現行正式資料庫');
    }
    this.pool = protectPostgresPool(new pg.Pool({ connectionString, max: 8, connectionTimeoutMillis: 30000,
      statement_timeout: 90000, query_timeout: 95000 }), { logger, scope: 'wallet-v2' });
  }
  async initialize() {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS wallet_v2_heads (
      wallet text PRIMARY KEY, revision integer NOT NULL, snapshot jsonb NOT NULL);
      CREATE TABLE IF NOT EXISTS wallet_v2_events (
      wallet text NOT NULL REFERENCES wallet_v2_heads(wallet), id text NOT NULL, block bigint NOT NULL,
      timestamp bigint NOT NULL, event jsonb NOT NULL, PRIMARY KEY(wallet,id));
      CREATE INDEX IF NOT EXISTS wallet_v2_events_time ON wallet_v2_events(wallet,timestamp);
      CREATE TABLE IF NOT EXISTS wallet_v2_views (id text PRIMARY KEY, revision integer NOT NULL, state jsonb NOT NULL);`);
  }
  async load(wallet) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const { rows } = await client.query('SELECT snapshot FROM wallet_v2_heads WHERE wallet=$1', [address(wallet)]);
      if (!rows.length) { await client.query('COMMIT'); return empty(address(wallet)); }
      // Sort references after reading: PostgreSQL must not sort full JSON proofs into temporary files.
      const events = await client.query('SELECT event FROM wallet_v2_events WHERE wallet=$1', [address(wallet)]);
      await client.query('COMMIT');
      return { ...rows[0].snapshot, events: events.rows.map(row => row.event).sort(ordered) };
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; } finally { client.release(); }
  }
  async save(wallet, expectedRevision, ledger) {
    wallet = address(wallet);
    const next = cleanJson({ ...ledger, version: SCHEMA_VERSION, wallet, revision: expectedRevision + 1 });
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,8453))', ['wallet-v2:' + wallet]);
      const current = await client.query('SELECT revision FROM wallet_v2_heads WHERE wallet=$1 FOR UPDATE', [wallet]);
      if ((current.rows[0]?.revision ?? 0) !== expectedRevision) throw Error('V2 ledger revision conflict');
      const { events, ...snapshot } = next;
      await client.query(`INSERT INTO wallet_v2_heads(wallet,revision,snapshot) VALUES($1,$2,$3)
        ON CONFLICT(wallet) DO UPDATE SET revision=excluded.revision,snapshot=excluded.snapshot`, [wallet, next.revision, snapshot]);
      for (const batch of eventBatches(events)) await client.query(`INSERT INTO wallet_v2_events(wallet,id,block,timestamp,event)
        SELECT $1,x.id,x.block,x.timestamp,x.event FROM jsonb_to_recordset($2::jsonb)
        AS x(id text,block bigint,timestamp bigint,event jsonb)
        ON CONFLICT(wallet,id) DO UPDATE SET event=excluded.event,block=excluded.block,timestamp=excluded.timestamp
        WHERE (wallet_v2_events.block,wallet_v2_events.timestamp,wallet_v2_events.event)
          IS DISTINCT FROM (excluded.block,excluded.timestamp,excluded.event)`, [wallet, batch]);
      await client.query('COMMIT'); return next;
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; } finally { client.release(); }
  }
  async close() { await this.pool.end(); }
  async loadView(id) {
    const { rows } = await this.pool.query('SELECT state FROM wallet_v2_views WHERE id=$1', [id]);
    return rows[0]?.state || null;
  }
  async pendingViews() {
    const { rows } = await this.pool.query("SELECT state FROM wallet_v2_views WHERE state->>'phase' IN ('loading','draft') AND state->>'channelId' IS NOT NULL AND state->>'messageId' IS NOT NULL");
    return rows.map(row => row.state);
  }
  async saveView(view, expectedRevision = 0) {
    const next = cleanJson({ ...view, revision: expectedRevision + 1 });
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,8453))', ['wallet-v2-view:' + view.id]);
      const current = await client.query('SELECT revision FROM wallet_v2_views WHERE id=$1 FOR UPDATE', [view.id]);
      if ((current.rows[0]?.revision ?? 0) !== expectedRevision) throw Error('V2 view revision conflict');
      await client.query(`INSERT INTO wallet_v2_views(id,revision,state) VALUES($1,$2,$3)
        ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,state=excluded.state`, [view.id, next.revision, next]);
      await client.query('COMMIT'); return next;
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; } finally { client.release(); }
  }
}

// Limit each SQL recordset, not the wallet's history. Every batch commits in the
// same transaction, so an error rolls back the entire checkpoint without data loss.
function* eventBatches(events) {
  let rows = [], bytes = 2;
  for (const event of events) {
    const row = JSON.stringify({ id: event.id, block: event.block, timestamp: event.timestamp, event });
    const size = Buffer.byteLength(row) + 1;
    if (rows.length && (bytes + size > 512 * 1024 || rows.length >= 500)) {
      yield '[' + rows.join(',') + ']'; rows = []; bytes = 2;
    }
    rows.push(row); bytes += size;
  }
  if (rows.length) yield '[' + rows.join(',') + ']';
}
