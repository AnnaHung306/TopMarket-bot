import {dateKey,eventTimes,midnight} from './time.mjs';

// Count windows exist independently of whether a giveaway was ever posted or
// drawn. The hour after 09:00 is intentionally outside both windows.
export function giveawayCountWindow(now) {
  if(!Number.isFinite(now)) throw Error('DAILY_GIVEAWAY_TIME_INVALID');
  const today=dateKey(now), boundary=midnight(today)+9*3600000;
  if(now>=boundary && now<boundary+3600000) return null;
  const day=now<boundary ? dateKey(midnight(today)-86400000) : today;
  const {start,end}=eventTimes(day,'giveaway');
  return {day,start,end};
}
