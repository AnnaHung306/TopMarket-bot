import { Client as NeonClient } from '@neondatabase/serverless';
import pg from 'pg';

async function withAdvisoryLock(query, parameters, run) {
  const url = new URL(process.env.DATABASE_URL);
  // Advisory locks belong to a Postgres session, so connect directly even if SQL reads use a pooler.
  if (process.env.DATABASE_DRIVER !== 'postgres') url.hostname = url.hostname.replace(/-pooler(?=\.)/, '');
  const Client = process.env.DATABASE_DRIVER === 'postgres' ? pg.Client : NeonClient;
  const client = new Client({ connectionString: url.href, connectionTimeoutMillis: 5_000 });
  let alive = true, heartbeat;
  const markLost = () => { alive = false; };
  const assertLock = () => {
    if (!alive) throw Error('Lost the Neon synchronization lock');
  };
  client.on('error', markLost);
  client.on('end', markLost);
  try {
    await client.connect();
    const { rows } = await client.query(query, parameters);
    if (!rows[0].acquired) return null;
    heartbeat = setInterval(() => { void client.query('SELECT 1').catch(markLost); }, 25_000);
    heartbeat.unref();
    return await run(assertLock);
  } finally {
    clearInterval(heartbeat);
    await client.end().catch(markLost);
  }
}


export function withHistoryLock(run) {
  return withAdvisoryLock('SELECT pg_try_advisory_lock(8453, 20261107) AS acquired', [], run);
}

export function withWalletLock(wallet, run) {
  return withAdvisoryLock('SELECT pg_try_advisory_lock(hashtextextended($1, 8453)) AS acquired',
    ['top-market-wallet-summary:' + wallet], run);
}
