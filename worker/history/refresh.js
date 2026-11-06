import { Client } from '@neondatabase/serverless';

export async function withHistoryLock(run) {
  const url = new URL(process.env.DATABASE_URL);
  // Advisory locks belong to a Postgres session, so connect directly even if SQL reads use a pooler.
  url.hostname = url.hostname.replace(/-pooler(?=\.)/, '');
  const client = new Client({ connectionString: url.href, connectionTimeoutMillis: 5_000 });
  let alive = true, heartbeat;
  const markLost = () => { alive = false; };
  const assertLock = () => {
    if (!alive) throw Error('Lost the Neon history synchronization lock');
  };
  client.on('error', markLost);
  client.on('end', markLost);
  try {
    await client.connect();
    const { rows } = await client.query('SELECT pg_try_advisory_lock(8453, 20261107) AS acquired');
    if (!rows[0].acquired) return null;
    heartbeat = setInterval(() => { void client.query('SELECT 1').catch(markLost); }, 25_000);
    heartbeat.unref();
    return await run(assertLock);
  } finally {
    clearInterval(heartbeat);
    await client.end().catch(markLost);
  }
}
