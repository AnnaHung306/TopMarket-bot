const DAY = 86_400_000;
const OFFSET = 8 * 3_600_000;
// Most recent weekday schedule only. The database does not prove an event opened.
export function latestScheduledWindow(now, hour) {
  const today = Date.parse(new Date(now + OFFSET).toISOString().slice(0,10) + 'T00:00:00+08:00');
  for (let offset=0; offset<8; offset++) {
    const midnight = today - offset * DAY;
    const weekday = new Date(midnight + OFFSET).getUTCDay();
    const start = midnight + hour * 3_600_000;
    if (weekday >= 1 && weekday <= 5 && start <= now) return {start,end:Math.min(now+1,start+23*3_600_000)};
  }
  throw Error('Cannot determine activity window');
}
