import pg from 'pg';

// Session-level lock and a dedicated deployment ledger for the private trial.
const LOCK_KEYS = [1541304826, 1572821315];
export async function acquireTrialLock({ connectionString, deploymentId, makeClient = options => new pg.Client(options) } = {}) {
  if (!connectionString?.trim()) throw Error('TRIAL_DATABASE_URL is required for single-instance operation');
  if (!deploymentId?.trim()) throw Error('RAILWAY_DEPLOYMENT_ID is required for single-instance operation');
  const db = makeClient({ connectionString, connectionTimeoutMillis: 5000, keepAlive: true });
  let held = false;
  let stopped = false;
  let superseded = false;
  const invalidate = () => { held = false; stopped = true; };
  db.on('error', invalidate);
  db.on('end', invalidate);
  await db.connect();
  await db.query(`CREATE TABLE IF NOT EXISTS public.discord_trial_deployment_epochs (
    deployment_id text PRIMARY KEY, generation bigint GENERATED ALWAYS AS IDENTITY UNIQUE NOT NULL
  )`);
  const registered = await db.query({
    text: `INSERT INTO public.discord_trial_deployment_epochs (deployment_id) VALUES ($1)
      ON CONFLICT (deployment_id) DO UPDATE SET deployment_id = EXCLUDED.deployment_id RETURNING generation`,
    values: [deploymentId], query_timeout: 5000,
  });
  const generation = registered.rows[0].generation;
  async function isLatest() {
    const result = await db.query({ text: `SELECT $1::bigint = max(generation) AS active FROM public.discord_trial_deployment_epochs`, values: [generation], query_timeout: 5000 });
    return result.rows[0].active === true;
  }
  if (!await isLatest()) {
    await db.end();
    return null;
  }
  console.log('Private channel trial requesting exclusive coordination lock');
  await db.query('SELECT pg_advisory_lock($1::integer, $2::integer)', LOCK_KEYS);
  if (!stopped) held = true;
  if (!held) throw Error('Trial lock connection was closed');
  if (!await isLatest()) { await db.end(); return null; }
  return {
    get superseded() { return superseded; },
    async canAct() {
      if (!held || stopped) return false;
      try {
        if (!await isLatest()) { superseded = true; held = false; return false; }
        return held && !stopped;
      } catch { invalidate(); return false; }
    },
    async close() {
      invalidate();
      try { await db.end(); } catch { /* Already closed. */ }
    },
  };
}
