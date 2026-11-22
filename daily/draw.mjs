import { randomInt } from 'node:crypto';

// Each candidate is eligible at most once, even if bad input contains duplicates.
export function drawWinners(userIds, limit = 2, random = randomInt) {
  const candidates = [...new Set(userIds)];
  const winners = [];
  while (candidates.length && winners.length < limit) {
    winners.push(candidates.splice(random(candidates.length), 1)[0]);
  }
  return winners;
}
