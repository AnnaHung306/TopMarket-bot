import assert from 'node:assert/strict';
import { createWalletHandler } from './discord-interaction.mjs';

const wallet = '0x' + 'a'.repeat(40), other = '0x' + 'b'.repeat(40);
const snapshot = { through: 99 }, adminId = '872351254536405093';
process.env.DISCORD_ADMIN_ID = adminId;

function interaction(address = wallet) {
  const edits = [], messages = [];
  const thread = { id: 'thread-123', async send(payload) {
    messages.push(payload);
    return { async edit(value) { edits.push(value); } };
  } };
  return { commandName: 'wallet', isChatInputCommand: () => true,
    options: { getString: () => address }, channelId: 'allowed-channel',
    user: { id: '123456789012345678', username: 'test-user' }, member: { displayName: '測試用戶' },
    edits, messages,
    async deferReply() { this.deferred = true; this.ackAt = performance.now(); },
    channel: { threads: { async create() { return thread; } } },
    async editReply(payload) { if (!this.first) this.first = payload; else edits.push(payload); this.replied = true; },
  };
}
const base = { configured: () => true, readSnapshot: async () => null,
  scanBlocked: async () => false, recordScanFailure: async () => {}, reserveScan: async () => true,
  readPage: async () => ({ ready: true, snapshot }), renderPoster: () => Buffer.from('PNG'), formatReport: () => '摘要' };
async function quiet(work) {
  const old = console.error; console.error = () => {};
  try { return await work(); } finally { console.error = old; }
}
function report(item) {
  const message = item.messages.find(value => value.files?.some(file => file.name === 'wallet-report.png'));
  assert.ok(message);
  assert.match(message.content, /^拍拍 <@123456789012345678>\n/);
  return message;
}
function noEarlyAlert(item) {
  assert.ok(item.messages.slice(0, -1).every(value => !String(value.content || '').includes(`<@${adminId}>`)));
}

let calls = 0, quota = 0, failed = 0;
const transient = interaction();
const began = performance.now();
await quiet(() => createWalletHandler({ ...base,
  reserveScan: async () => { quota++; return true; },
  recordScanFailure: async () => { failed++; },
  readPage: async () => { if (++calls === 1) throw Error('temporary'); return { ready: true, snapshot }; },
})(transient));
assert.ok(transient.ackAt - began < 3_000);
assert.equal(calls, 2); assert.equal(quota, 1); assert.equal(failed, 0);
report(transient); noEarlyAlert(transient);
assert.ok(transient.edits.every(value => !String(value).includes('未完成')));
console.log('PASS 1: transient error retried privately within one quota reservation');

calls = quota = failed = 0;
const twice = interaction();
await quiet(() => createWalletHandler({ ...base,
  reserveScan: async () => { quota++; return true; },
  recordScanFailure: async () => { failed++; },
  readPage: async () => { calls++; throw Error('unavailable'); },
})(twice));
assert.equal(calls, 2); assert.equal(quota, 1); assert.equal(failed, 1);
noEarlyAlert(twice);
assert.match(twice.messages.at(-1).content, new RegExp(`<@${adminId}>.*連續兩次`));
assert.deepEqual(twice.messages.at(-1).allowedMentions, { users: [adminId] });
console.log('PASS 2: two failures produce one en alert');

const blocked = interaction();
await createWalletHandler({ ...base, scanBlocked: async () => true,
  reserveScan: async () => { throw Error('quota touched'); },
  readPage: async () => { throw Error('RPC touched'); } })(blocked);
assert.match(blocked.edits.at(-1), /暫停重試/);
console.log('PASS 3: persisted failure prevents repeat spend');

let release, entered;
const pending = new Promise(resolve => { release = resolve; });
const reached = new Promise(resolve => { entered = resolve; });
quota = 0;
const handler = createWalletHandler({ ...base,
  readSnapshot: async address => address === other ? snapshot : null,
  reserveScan: async () => { quota++; return true; },
  readPage: async () => { entered(); await pending; return { ready: true, snapshot }; },
});
const cold = interaction(); const coldTask = handler(cold);
await reached;
const cached = interaction(other); await handler(cached);
report(cached); assert.equal(quota, 1);
release(); await coldTask; report(cold);
console.log('PASS 4: cached report remains available during cold scan');

calls = 0;
const resumed = interaction();
await quiet(() => createWalletHandler({ ...base, readPage: async () => ++calls === 1
  ? { ready: false, progress: { through: 50, target: 99 } } : { ready: true, snapshot } })(resumed));
assert.equal(calls, 2); report(resumed); noEarlyAlert(resumed);
console.log('PASS 5: saved checkpoint resumes automatically');

calls = 0;
const unfinished = interaction();
await quiet(() => createWalletHandler({ ...base,
  readPage: async () => ({ ready: false, progress: { through: ++calls, target: 99 } }),
})(unfinished));
assert.equal(calls, 2);
assert.match(unfinished.messages.at(-1).content, /連續兩次掃描未完成/);
assert.ok(!unfinished.messages.some(value => value.files?.some(file => file.name === 'wallet-report.png')));
console.log('PASS 6: incomplete history is never marked complete');

for (const [name, address, overrides, expected] of [
  ['invalid', 'invalid', {}, /請輸入有效/],
  ['unconfigured', wallet, { configured: () => false }, /尚未完成設定/],
  ['quota', wallet, { reserveScan: async () => false }, /額度已用完/],
  ['cached', wallet, { readSnapshot: async () => snapshot }, /已完成/],
]) {
  let rpc = 0; const item = interaction(address);
  await createWalletHandler({ ...base, ...overrides, readPage: async () => { rpc++; return { ready: true, snapshot }; } })(item);
  assert.equal(rpc, 0, name); assert.match(item.edits.at(-1), expected);
  if (name === 'cached') report(item);
  console.log(`PASS 7-10 ${name}: no avoidable Alchemy scan`);
}
delete process.env.DISCORD_ADMIN_ID;
