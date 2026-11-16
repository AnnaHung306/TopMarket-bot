// Reserve the full estimated budget before each scan. The shared daily limit
// persists across restarts and is deliberately charged even for failed scans.
export const SCAN_MAX_UNITS = 25000;
export const DAILY_SCAN_LIMIT = 4;
export const SCAN_BLOCK_WINDOW = 10000;

async function ensureFailures(sql) {
  await sql`CREATE TABLE IF NOT EXISTS discord_scan_failures (
    wallet text PRIMARY KEY, failed_day date NOT NULL
  )`;
}

// A scan that failed before committing its checkpoint should not be retried
// repeatedly on the same day. Successful cached reports remain available.
export async function scanBlocked(sql, wallet) {
  await ensureFailures(sql);
  const rows = await sql`SELECT 1 FROM discord_scan_failures
    WHERE wallet = ${wallet} AND failed_day = (now() AT TIME ZONE 'UTC')::date`;
  return rows.length > 0;
}

export async function recordScanFailure(sql, wallet) {
  await ensureFailures(sql);
  await sql`INSERT INTO discord_scan_failures (wallet, failed_day)
    VALUES (${wallet}, (now() AT TIME ZONE 'UTC')::date)
    ON CONFLICT (wallet) DO UPDATE SET failed_day = excluded.failed_day`;
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
  return rows.length === 1;
}
