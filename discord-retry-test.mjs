import assert from 'node:assert/strict';
import { createScanRunner } from './discord-scan-runner.mjs';
import { nextUtcMidnight } from './discord-scan-jobs.mjs';

const wallet = '0x' + 'a'.repeat(40);
const requester = '123456789012345678', admin = '872351254536405093';
const snapshot = { through: 99 };
process.env.DISCORD_ADMIN_ID = admin;

function harness(overrides = {}) {
  const queue = [{ wallet, thread_id: 'thread-123', requester_id: requester, status_id: 'status-123', failures: 0 }];
  const messages = [], edits = [], rescheduled = [], removed = [];
  let reserved = 0, released = 0, recorded = 0;
  const status = { async edit(value) { edits.push(value); } };
  const thread = { isThread: () => true, messages: { async fetch() { return status; } },
    async send(value) { messages.push(value); return { id: 'result-123' }; } };
  const jobs = {
    async claim() { return queue.shift() || null; },
    async reschedule(address, options) { assert.equal(address, wallet); rescheduled.push(options); },
    async remove(address) { removed.push(address); },
  };
  const base = { client: { channels: { async fetch() { return thread; } } }, jobs,
    readSnapshot: async () => null, readProgress: async () => null,
    readPage: async () => ({ ready: true, snapshot }),
    reserveScan: async () => { reserved++; return true; },
    releaseUnusedScan: async () => { released++; },
    recordScanFailure: async () => { recorded++; },
    renderPoster: async () => Buffer.from('PNG'), formatReport: () => '摘要',
    maxMs: 5_000, maxUnits: 100,
  };
  const runner = createScanRunner({ ...base, ...overrides });
  return { runner, queue, messages, edits, rescheduled, removed,
    counts: () => ({ reserved, released, recorded }), thread };
}
async function quiet(work) {
  const oldError = console.error, oldInfo = console.info;
  console.error = console.info = () => {};
  try { return await work(); } finally { console.error = oldError; console.info = oldInfo; }
}

let reads = 0;
const transient = harness({ readPage: async () => {
  if (++reads === 1) throw Error('temporary');
  return { ready: true, snapshot };
} });
await quiet(() => transient.runner.wake());
assert.equal(reads, 2);
assert.deepEqual(transient.counts(), { reserved: 1, released: 0, recorded: 0 });
assert.equal(transient.rescheduled.length, 0);
assert.equal(transient.removed.length, 1);
assert.match(transient.messages[0].content, new RegExp(`^拍拍 <@${requester}>`));
assert.deepEqual(transient.messages[0].allowedMentions, { users: [requester] });
console.log('PASS: first real failure is retried silently in one reservation');

reads = 0;
const twice = harness({ readPage: async () => { reads++; throw Error('upstream unavailable'); } });
await quiet(() => twice.runner.wake());
assert.equal(reads, 2);
assert.deepEqual(twice.counts(), { reserved: 1, released: 0, recorded: 1 });
assert.equal(twice.removed.length, 1);
assert.match(twice.messages[0].content, new RegExp(`<@${admin}>.*連續兩次`));
assert.deepEqual(twice.messages[0].allowedMentions, { users: [admin] });
assert.ok(!twice.messages.some(message => String(message.content).includes(`<@${requester}>`)));
console.log('PASS: only two real failures alert the MOD, not the requester');

const alertRetry = harness({ readPage: async () => { throw Error('upstream unavailable'); } });
const originalSend = alertRetry.thread.send;
let alertPosts = 0;
alertRetry.thread.send = async function(message) {
  if (++alertPosts === 1) throw Error('temporary Discord send error');
  return originalSend.call(this, message);
};
await quiet(() => alertRetry.runner.wake());
assert.equal(alertRetry.rescheduled.at(-1).failures, 2);
assert.equal(alertRetry.removed.length, 0);
alertRetry.queue.push({ wallet, thread_id: 'thread-123', requester_id: requester,
  status_id: 'status-123', failures: 2 });
await quiet(() => alertRetry.runner.wake());
assert.equal(alertRetry.counts().reserved, 1);
assert.equal(alertRetry.messages.length, 1);
assert.equal(alertRetry.removed.length, 1);
console.log('PASS: a failed MOD alert retries without another Alchemy scan');

reads = 0;
const progressed = harness({ readPage: async (_wallet, budget) => {
  budget.units = budget.maxUnits;
  return { ready: false, progress: { from: 1, through: ++reads * 50, target: 100 } };
} });
await quiet(() => progressed.runner.wake());
assert.equal(reads, 1);
assert.equal(progressed.rescheduled.length, 1);
assert.equal(progressed.counts().recorded, 0);
assert.match(progressed.edits.at(-1), /50\.0%/);
assert.ok(!progressed.messages.length);
console.log('PASS: CU ceiling preserves true checkpoint without a failure or alert');

const limit = harness({ readPage: async () => { throw Error('Alchemy sync time limit reached; requests=1'); } });
await quiet(() => limit.runner.wake());
assert.equal(limit.rescheduled.length, 1);
assert.equal(limit.counts().recorded, 0);
assert.match(limit.edits.at(-1), /尚未取得可保存的檢查點/);
assert.equal(limit.rescheduled[0].blockWindow, 100_000);
assert.equal(limit.rescheduled[0].stalls, 1);
console.log('PASS: a time limit narrows the block range without false failure');

limit.queue.push({ wallet, thread_id: 'thread-123', requester_id: requester,
  status_id: 'status-123', failures: 0, stalls: 1, block_window: 100_000 });
await quiet(() => limit.runner.wake());
assert.equal(limit.rescheduled[1].blockWindow, 20_000);
assert.equal(limit.rescheduled[1].stalls, 2);
limit.queue.push({ wallet, thread_id: 'thread-123', requester_id: requester,
  status_id: 'status-123', failures: 0, stalls: 2, block_window: 20_000 });
await quiet(() => limit.runner.wake());
assert.deepEqual(limit.counts(), { reserved: 3, released: 0, recorded: 1 });
assert.equal(limit.removed.length, 1);
assert.match(limit.messages[0].content, new RegExp(`<@${admin}>`));
console.log('PASS: three no-progress segments stop further Alchemy spend and alert MOD');

const locked = harness({ readPage: async () => ({ ready: false, waiting: true }) });
await quiet(() => locked.runner.wake());
assert.equal(locked.rescheduled.length, 1);
assert.equal(locked.counts().recorded, 0);
assert.equal(locked.counts().released, 1);
console.log('PASS: an active wallet lock refunds the unused reservation');

const noQuota = harness({ reserveScan: async () => false });
await quiet(() => noQuota.runner.wake());
assert.equal(noQuota.rescheduled.length, 1);
assert.ok(noQuota.rescheduled[0].nextRunAt > new Date());
assert.match(noQuota.edits.at(-1), /UTC 零點後自動續掃/);
assert.deepEqual(noQuota.counts(), { reserved: 0, released: 0, recorded: 0 });
assert.equal(nextUtcMidnight(new Date('2026-11-17T22:30:00Z')).toISOString(), '2026-11-18T00:00:05.000Z');
console.log('PASS: exhausted daily quota resumes automatically next UTC day');

const cached = harness({ readSnapshot: async () => snapshot,
  reserveScan: async () => { throw Error('cached report cannot reserve Alchemy'); } });
await quiet(() => cached.runner.wake());
assert.equal(cached.messages.length, 1);
assert.equal(cached.removed.length, 1);
console.log('PASS: completed snapshot delivers without another Alchemy reservation');

let posterAttempts = 0;
const restart = harness({ readSnapshot: async () => snapshot,
  renderPoster: async () => { if (++posterAttempts === 1) throw Error('temporary renderer error'); return Buffer.from('PNG'); },
  reserveScan: async () => { throw Error('renderer retry cannot reserve Alchemy'); } });
await quiet(() => restart.runner.wake());
assert.equal(restart.rescheduled.length, 1);
assert.equal(restart.messages.length, 0);
restart.queue.push({ wallet, thread_id: 'thread-123', requester_id: requester, status_id: 'status-123', failures: 1 });
const resumed = createScanRunner({ client: { channels: { async fetch() { return restart.thread; } } },
  jobs: { claim: async () => restart.queue.shift() || null,
    reschedule: async () => { throw Error('should complete'); },
    remove: async () => restart.removed.push(wallet) },
  readSnapshot: async () => snapshot, readPage: async () => { throw Error('should not scan'); },
  reserveScan: async () => { throw Error('should not reserve'); }, recordScanFailure: async () => {},
  renderPoster: async () => { posterAttempts++; return Buffer.from('PNG'); }, formatReport: () => '摘要' });
await quiet(() => resumed.wake());
assert.equal(posterAttempts, 2);
assert.equal(restart.messages.length, 1);
assert.equal(restart.removed.length, 1);
console.log('PASS: queued result survives a runner restart without re-scanning');

const liveProgress = harness({ progressIntervalMs: 10,
  readPage: async (_wallet, budget) => {
    budget.units = 42;
    await new Promise(resolve => setTimeout(resolve, 30));
    return { ready: true, snapshot };
  } });
await quiet(() => liveProgress.runner.wake());
assert.ok(liveProgress.edits.some(edit => /42 \/ 100 估算 CU/.test(edit)));
assert.match(liveProgress.edits.at(-1), /已完成/);
console.log('PASS: in-flight status reports real estimated CU before delivery');

const tenJobs = Array.from({ length: 10 }, (_, index) => ({
  wallet: `0x${index.toString(16).padStart(40, '0')}`,
  thread_id: `thread-${index}`, requester_id: requester,
  status_id: `status-${index}`, failures: 0,
}));
const dailyQueue = [...tenJobs], dailyMessages = [], dailyDelayed = [], dailyRemoved = [];
let dailyReservations = 0, dailyUnits = 0;
const dailyThread = { isThread: () => true,
  messages: { async fetch() { return { async edit() {} }; } },
  async send(message) { dailyMessages.push(message); } };
const dailyRunner = createScanRunner({
  client: { channels: { async fetch() { return dailyThread; } } },
  jobs: { async claim() { return dailyQueue.shift() || null; },
    async reschedule(address, options) { dailyDelayed.push({ address, options }); },
    async remove(address) { dailyRemoved.push(address); } },
  readSnapshot: async () => null, readProgress: async () => null,
  reserveScan: async () => { if (dailyReservations === 8) return false; dailyReservations++; return true; },
  recordScanFailure: async () => { throw Error('No failures expected'); },
  readPage: async (_address, budget) => {
    budget.units = budget.maxUnits;
    dailyUnits += budget.units;
    return { ready: true, snapshot };
  },
  renderPoster: async () => Buffer.from('PNG'), formatReport: () => '摘要',
});
await quiet(() => dailyRunner.wake());
assert.equal(dailyReservations, 8);
assert.equal(dailyUnits, 8 * 80_000);
assert.equal(dailyRemoved.length, 8);
assert.equal(dailyMessages.length, 8);
assert.equal(dailyDelayed.length, 2);
assert.ok(dailyDelayed.every(item => item.options.nextRunAt > new Date()));
console.log('PASS: ten simulated cold wallets cannot exceed eight daily reservations or 640,000 estimated CU');

delete process.env.DISCORD_ADMIN_ID;
