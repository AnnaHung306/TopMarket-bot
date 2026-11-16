// Reserve the full estimated budget before each scan. The shared daily limit
// persists across restarts and is deliberately charged even for failed scans.
export const SCAN_MAX_UNITS = 25000;
export const DAILY_SCAN_LIMIT = 4;
export const SCAN_BLOCK_WINDOW = 10000;

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
