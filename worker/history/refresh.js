import { Client } from '@neondatabase/serverless';
import { alchemy } from './chain.js';
import { publishedHead } from './store.js';
import { synchronize } from './sync.js';

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

export async function refreshHistory(sql, through) {
  const published = await publishedHead(sql);
  if (!published) return null;
  const finalized = await alchemy({ maxUnits: 500 }).rpc('eth_getBlockByNumber', ['finalized', false]);
  const finalizedBlock = Number(finalized?.number);
  if (!finalized?.hash || !Number.isSafeInteger(finalizedBlock) || finalizedBlock < published.block) {
    throw Error('Cannot verify the finalized Base block for this report');
  }
  const target = Math.min(through ?? finalizedBlock, finalizedBlock);
  const result = head => ({ ready: head >= target, target, head });
  if (published.block >= target) return result(published.block);

  const refreshed = await withHistoryLock(async assertLock => {
    const latest = await publishedHead(sql);
    if (latest.block >= target) return result(latest.block);
    const reader = alchemy({ maxUnits: 1_250_000, maxMs: 245_000, beforeRequest: assertLock });
    const stats = await synchronize(sql, { reader, maxMs: 220_000, range: 5_000, through: target, assertLock });
    return { ...result(stats.through), blocks: stats.through - latest.block, seconds: stats.seconds };
  });
  return refreshed ?? result(published.block);
}
