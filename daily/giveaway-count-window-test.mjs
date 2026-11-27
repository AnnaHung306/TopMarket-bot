import assert from 'node:assert/strict';
import {giveawayCountWindow} from './giveaway-count-window.mjs';
import {eventTimes} from './time.mjs';

const fri=eventTimes('2026-11-27','giveaway'),sat=eventTimes('2026-11-28','giveaway');
assert.equal(giveawayCountWindow(fri.start-1),null);
assert.equal(giveawayCountWindow(fri.start).day,'2026-11-27');
assert.equal(giveawayCountWindow(fri.end-1).day,'2026-11-27');
assert.equal(giveawayCountWindow(fri.end),null);
assert.equal(giveawayCountWindow(sat.start-1),null);
assert.equal(giveawayCountWindow(sat.start).day,'2026-11-28');
assert.equal(giveawayCountWindow(sat.end-1).day,'2026-11-28');
assert.equal(giveawayCountWindow(sat.end),null);
assert.throws(()=>giveawayCountWindow(NaN),/TIME_INVALID/);
console.log('independent daily count window tests passed');
