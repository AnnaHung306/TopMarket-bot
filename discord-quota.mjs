// Reserve the full estimated budget before each scan. The shared daily limit
// persists across restarts and is deliberately charged even for failed scans.
// One reservation covers all Gavin history pages and up to two failed passes.
// A shared budget prevents every saved page from resetting the PAYG ceiling.
export const SCAN_MAX_UNITS = 80000;
export const SCAN_ATTEMPTS = 2;
export const SCAN_MAX_MS = 52000;
export const DAILY_SCAN_LIMIT = 8;
// Version 3 also blocked wallets after a normal time/CU checkpoint. Those
// records must not prevent the corrected background queue from resuming.
const SCAN_ALGORITHM_VERSION = 4;
// Smaller checkpoints make long-running background scans resumable after a
// timeout or deployment restart. The shared CU and daily caps still apply.
export const SCAN_BLOCK_WINDOW = 500_000;

async function ensureFailures(sql) {
  await sql`CREATE TABLE IF NOT EXISTS discord_scan_failures (
    wallet text PRIMARY KEY, failed_day date NOT NULL,
    algorithm_version integer NOT NULL DEFAULT 1
  )`;
  await sql`ALTER TABLE discord_scan_failures
    ADD COLUMN IF NOT EXISTS algorithm_version integer NOT NULL DEFAULT 1`;
}

// Only two real failures block new work for the rest of the UTC day.
export async function scanBlocked(sql, wallet) {
  await ensureFailures(sql);
  const rows = await sql`SELECT 1 FROM discord_scan_failures
    WHERE wallet = ${wallet} AND failed_day = (now() AT TIME ZONE 'UTC')::date
      AND algorithm_version = ${SCAN_ALGORITHM_VERSION}`;
  return rows.length > 0;
}

export async function recordScanFailure(sql, wallet) {
  await ensureFailures(sql);
  await sql`INSERT INTO discord_scan_failures (wallet, failed_day, algorithm_version)
    VALUES (${wallet}, (now() AT TIME ZONE 'UTC')::date, ${SCAN_ALGORITHM_VERSION})
    ON CONFLICT (wallet) DO UPDATE SET failed_day = excluded.failed_day,
      algorithm_version = excluded.algorithm_version`;
  await sql`DELETE FROM discord_scan_failures
    WHERE failed_day < (now() AT TIME ZONE 'UTC')::date`;
}

export async function reserveScan(sql) {
  await sql`CREATE TABLE IF NOT EXISTS discord_scan_quota (
    quota_day date PRIMARY KEY, reservations integer NOT NULL DEFAULT 0
  )`;
  const rows = await sql`INSERT INTO discord_scan_quota (quota_day, reservations)
    VALUES ((now() AT TIME ZONE 'UTC')::date, 1)
    ON CONFLICT (quota_day) DO UPDATE SET reservations = discord_scan_quota.reservations + 1
    WHERE discord_scan_quota.reservations < ${DAILY_SCAN_LIMIT}
    RETURNING reservations`;
  await sql`DELETE FROM discord_scan_quota
    WHERE quota_day < (now() AT TIME ZONE 'UTC')::date - 7`;
  return rows.length === 1;
}

// A lock collision cannot issue any Alchemy request, so it must not consume
// the day's scan quota. Other failed or timed-out segments keep their charge.
export async function releaseUnusedScan(sql) {
  await sql`UPDATE discord_scan_quota SET reservations = reservations - 1
    WHERE quota_day = (now() AT TIME ZONE 'UTC')::date AND reservations > 0`;
}
