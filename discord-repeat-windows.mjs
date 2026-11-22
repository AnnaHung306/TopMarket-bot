const DAY = 86_400_000;
const OFFSET = 8 * 3_600_000;
// Daily scheduled interval. The database does not prove an event opened.
export function latestScheduledWindow(now, hour) {
  const today = Date.parse(new Date(now + OFFSET).toISOString().slice(0,10) + 'T00:00:00+08:00');
  let start = today + hour * 3_600_000;
  if (start > now) start -= DAY;
  return { start, end: Math.min(now + 1, start + DAY) };
}
