import pg from 'pg';

// Session-level lock, unique to the private trial. No tables or data are read or written.
const LOCK_KEYS = [1541304826, 1572821315];
export async function acquireTrialLock({ connectionString, makeClient = options => new pg.Client(options) } = {}) {
  if (!connectionString?.trim()) throw Error('TRIAL_DATABASE_URL is required for single-instance operation');
  const db = makeClient({ connectionString, connectionTimeoutMillis: 5000, keepAlive: true });
  let held = false;
  let stopped = false;
  const invalidate = () => { held = false; stopped = true; };
  db.on('error', invalidate);
  db.on('end', invalidate);
  await db.connect();
  console.log('Private channel trial requesting exclusive coordination lock');
  await db.query('SELECT pg_advisory_lock($1::integer, $2::integer)', LOCK_KEYS);
  if (!stopped) held = true;
  if (!held) throw Error('Trial lock connection was closed');
  return {
    async canAct() {
      if (!held || stopped) return false;
      try {
        const result = await db.query({
          text: `SELECT NOT EXISTS (
            SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND classid = $1::oid
            AND objid = $2::oid AND objsubid = 2 AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
            AND NOT granted AND pid <> pg_backend_pid()
          ) AS active`,
          values: LOCK_KEYS,
          query_timeout: 5000,
        });
        // A waiting instance takes precedence. Stop immediately; heartbeat closes this session.
        if (!result.rows[0].active) { held = false; return false; }
        return held && !stopped;
      } catch { invalidate(); return false; }
    },
    async close() {
      invalidate();
      try { await db.end(); } catch { /* Already closed. */ }
    },
  };
}
