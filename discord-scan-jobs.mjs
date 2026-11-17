// A bounded, durable queue for wallet scans. One row represents one wallet;
// a fixed slot prevents concurrent requests from growing the queue past 100.
const MAX_JOBS = 100;
let schemaReady;

async function initialize(sql) {
  await sql`CREATE TABLE IF NOT EXISTS discord_scan_jobs (
    wallet text PRIMARY KEY,
    slot integer NOT NULL UNIQUE CHECK (slot BETWEEN 1 AND 100),
    thread_id text NOT NULL,
    requester_id text NOT NULL,
    status_id text NOT NULL,
    after_block integer,
    failures integer NOT NULL DEFAULT 0,
    stalls integer NOT NULL DEFAULT 0,
    block_window integer NOT NULL DEFAULT 500000,
    next_run_at timestamptz NOT NULL DEFAULT now(),
    lease_until timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  )`;
  await sql`ALTER TABLE discord_scan_jobs
    ADD COLUMN IF NOT EXISTS stalls integer NOT NULL DEFAULT 0`;
  await sql`ALTER TABLE discord_scan_jobs
    ADD COLUMN IF NOT EXISTS block_window integer NOT NULL DEFAULT 500000`;
  await sql`ALTER TABLE discord_scan_jobs
    ADD COLUMN IF NOT EXISTS after_block integer`;
  await sql`CREATE INDEX IF NOT EXISTS discord_scan_jobs_due_idx
    ON discord_scan_jobs (next_run_at, created_at)`;
}

function ready(sql) {
  schemaReady ??= initialize(sql).catch(error => { schemaReady = undefined; throw error; });
  return schemaReady;
}

export async function enqueueScanJob(sql, { wallet, threadId, requesterId, statusId, afterBlock = null }) {
  await ready(sql);
  if (afterBlock !== null && (!Number.isSafeInteger(afterBlock) || afterBlock < 0)) {
    throw Error('Invalid wallet refresh checkpoint');
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const [existing] = await sql`SELECT thread_id FROM discord_scan_jobs WHERE wallet = ${wallet}`;
    if (existing) return { accepted: false, existingThreadId: existing.thread_id };
    const rows = await sql`INSERT INTO discord_scan_jobs (wallet, slot, thread_id, requester_id, status_id, after_block)
      SELECT ${wallet}, slots.slot, ${threadId}, ${requesterId}, ${statusId}, ${afterBlock}
      FROM generate_series(1, ${MAX_JOBS}) AS slots(slot)
      WHERE NOT EXISTS (SELECT 1 FROM discord_scan_jobs occupied WHERE occupied.slot = slots.slot)
      ORDER BY slots.slot LIMIT 1
      ON CONFLICT DO NOTHING RETURNING wallet`;
    if (rows.length) return { accepted: true };
    const [winner] = await sql`SELECT thread_id FROM discord_scan_jobs WHERE wallet = ${wallet}`;
    if (winner) return { accepted: false, existingThreadId: winner.thread_id };
  }
  return { accepted: false, full: true };
}

export async function claimScanJob(sql) {
  await ready(sql);
  const [job] = await sql`UPDATE discord_scan_jobs SET lease_until = now() + interval '45 seconds'
    WHERE wallet = (
      SELECT wallet FROM discord_scan_jobs
      WHERE next_run_at <= now() AND (lease_until IS NULL OR lease_until <= now())
      ORDER BY (after_block IS NOT NULL), next_run_at, created_at FOR UPDATE SKIP LOCKED LIMIT 1
    )
    RETURNING wallet, thread_id, requester_id, status_id, after_block, failures, stalls, block_window`;
  return job || null;
}

export async function renewScanLease(sql, wallet) {
  await ready(sql);
  await sql`UPDATE discord_scan_jobs SET lease_until = now() + interval '45 seconds'
    WHERE wallet = ${wallet} AND lease_until > now()`;
}

export async function rescheduleScanJob(sql, wallet, { nextRunAt = new Date(), failures, stalls, blockWindow } = {}) {
  await ready(sql);
  await sql`UPDATE discord_scan_jobs SET next_run_at = ${nextRunAt.toISOString()},
    failures = COALESCE(${failures ?? null}, failures),
    stalls = COALESCE(${stalls ?? null}, stalls),
    block_window = COALESCE(${blockWindow ?? null}, block_window),
    lease_until = NULL
    WHERE wallet = ${wallet}`;
}

export async function removeScanJob(sql, wallet) {
  await ready(sql);
  await sql`DELETE FROM discord_scan_jobs WHERE wallet = ${wallet}`;
}

export function nextUtcMidnight(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 5));
}
