const DAY = 86400000;
const shifted = now => new Date(now + 8 * 3600000);
export const dateKey = now => shifted(now).toISOString().slice(0, 10);
export const midnight = day => Date.parse(`${day}T00:00:00+08:00`);
export function qualificationStart(now) {
  const start = midnight(dateKey(now)) + 8 * 3600000;
  return now < start ? start - DAY : start;
}
export function eventTimes(day, kind) {
  const start = midnight(day) + (kind === 'giveaway' ? 10 : 12) * 3600000;
  return { start, end: start + 23 * 3600000 };
}
