import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { acquireTrialLock } from './discord-trial-lock.mjs';
import { createScamTestHandler } from './discord-scam-test.mjs';
import { createGreetingHandler } from './discord-greetings.mjs';

let owner, waiter, waiterStarted;
class FakeClient extends EventEmitter {
  async connect() {}
  async query(sql) {
    if (typeof sql === 'string' && sql.includes('pg_advisory_lock')) {
      if (owner) {
        await new Promise(resolve => { waiter = () => { owner = this; waiter = undefined; resolve(); }; waiterStarted(); });
      } else owner = this;
      return { rows: [{}] };
    }
    if (owner !== this) throw Error('connection lost');
    return { rows: [{ active: !waiter }] };
  }
  async end() { if (owner === this) { owner = undefined; if (waiter) waiter(); } this.emit('end'); }
}
const makeClient = () => new FakeClient();
await assert.rejects(acquireTrialLock({ connectionString: '', makeClient }), /required/);
const waitStarted = new Promise(resolve => { waiterStarted = resolve; });
const first = await acquireTrialLock({ connectionString: 'test', makeClient });
const secondPending = acquireTrialLock({ connectionString: 'test', makeClient });
await waitStarted;
assert.equal(await first.canAct(), false);
await first.close();
assert.equal(await first.canAct(), false);
const second = await secondPending;
assert.equal(await second.canAct(), true);
await second.close();
let deleted = false, sent = false, authorized = true;
const message = { guildId: '1541304826674155550', channelId: '1572821315507855430', author: { id: '1', bot: false }, content: 'Free Nitro https://example.invalid', delete: async () => { deleted = true; }, channel: { send: async () => { sent = true; } } };
await createScamTestHandler({ canAct: async () => authorized, checkLinks: async () => { authorized = false; return { reason: null, unavailable: false }; } })(message);
assert.equal(deleted, false);
assert.equal(sent, false);
let replied = false;
await createGreetingHandler({ user: { id: '123' } }, { canAct: async () => false })({ ...message, content: '<@123> 早安', reply: async () => { replied = true; } });
assert.equal(replied, false);
console.log('Trial single-owner, fail-closed and handover tests passed');
