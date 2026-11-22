const DAY = 86400000;
const shifted = now => new Date(now + 8 * 3600000);
export const dateKey = now => shifted(now).toISOString().slice(0, 10);
export const midnight = day => Date.parse(`${day}T00:00:00+08:00`);
export function eventTimes(day, kind) {
  if (!['giveaway', 'quiz'].includes(kind)) throw Error('DAILY_ACTIVITY_KIND_INVALID');
  const start = midnight(day) + 10 * 3600000;
  return { start, end: start + DAY - 3600000 };
}
export const reportTime = (day, kind) => eventTimes(day, kind).end + 3600000;
export function isActivityDay(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(midnight(day)) || dateKey(midnight(day)) !== day) return false;
  const weekday=new Date(midnight(day)+8*3600000).getUTCDay();
  return weekday>=1 && weekday<=5;
}
