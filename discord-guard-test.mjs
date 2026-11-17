import assert from 'node:assert/strict';
import { createWalletHandler, shouldRefreshSnapshot } from './discord-interaction.mjs';

const wallet = '0x' + 'a'.repeat(40), userId = '123456789012345678';
const snapshot = { through: 99, asOf: new Date().toISOString() };

function interaction(address = wallet) {
  const edits = [], messages = [];
  const thread = { id: 'thread-123', async send(payload) {
    messages.push(payload);
    return { id: 'status-123', async edit(value) { edits.push(value); } };
  } };
  return { commandName: 'wallet', isChatInputCommand: () => true,
    options: { getString: () => address }, channelId: 'allowed-channel',
    user: { id: userId, username: 'test-user' }, member: { displayName: '測試用戶' },
    edits, messages,
    async deferReply() { this.deferred = true; this.ackAt = performance.now(); },
    channel: { threads: { async create() { return thread; } } },
    async editReply(payload) { if (!this.first) this.first = payload; else edits.push(payload); this.replied = true; },
  };
}

const base = { configured: () => true, readSnapshot: async () => null,
  scanBlocked: async () => false, enqueueScan: async () => ({ accepted: true }), wake: () => {},
  renderPoster: () => Buffer.from('PNG'), formatReport: () => '摘要' };
function assertInitial(item, began) {
  assert.ok(item.ackAt - began < 3_000);
  assert.equal(item.first.content, '貓貓正在努力工作，請稍後... 完成後會拍拍通知');
  assert.equal(item.first.files[0].name, 'cat-wait.gif');
  assert.equal(item.messages[0], '正在檢查地址與已儲存報表。');
  assert.ok(item.messages.every(message => typeof message === 'string' ||
    !message.files?.some(file => file.name === 'cat-wait.gif')));
}

const cases = [
  ['invalid', 'invalid', {}, /有效的 Base 錢包地址/, false],
  ['unconfigured', wallet, { configured: () => false }, /尚未完成設定/, false],
  ['cached', wallet, { readSnapshot: async () => snapshot }, /已完成/, false],
  ['blocked', wallet, { scanBlocked: async () => true }, /掃描已停止並通知 MOD/, false],
  ['full', wallet, { enqueueScan: async () => ({ full: true }) }, /佇列已滿/, true],
  ['duplicate', wallet, { enqueueScan: async () => ({ existingThreadId: 'older-thread' }) }, /older-thread/, true],
  ['queued-1', wallet, {}, /已排入背景掃描/, true],
  ['queued-2', wallet, {}, /已排入背景掃描/, true],
  ['queued-3', wallet, {}, /已排入背景掃描/, true],
  ['queued-4', wallet, {}, /已排入背景掃描/, true],
];
for (const [name, address, overrides, expected, shouldEnqueue] of cases) {
  let enqueued = 0, wakes = 0;
  const item = interaction(address), began = performance.now();
  await createWalletHandler({ ...base, ...overrides,
    enqueueScan: async job => { enqueued++; assert.deepEqual(job, {
      wallet, threadId: 'thread-123', requesterId: userId, statusId: 'status-123',
    }); return overrides.enqueueScan?.(job) ?? { accepted: true }; },
    wake: () => { wakes++; },
  })(item);
  assertInitial(item, began);
  assert.match(String(item.edits.at(-1)), expected, name);
  assert.equal(enqueued, Number(shouldEnqueue), name);
  assert.equal(wakes, name.startsWith('queued-') ? 1 : 0, name);
  if (name === 'cached') {
    assert.match(item.messages.at(-1).content, new RegExp(`^拍拍 <@${userId}>`));
    assert.deepEqual(item.messages.at(-1).allowedMentions, { users: [userId] });
  }
  console.log(`PASS ${name}: initial acknowledgement and bounded queue behavior`);
}

const fixedNow = Date.parse('2026-11-17T09:00:00Z');
assert.equal(shouldRefreshSnapshot({ asOf: '2026-11-16T09:00:01Z' }, fixedNow), false);
assert.equal(shouldRefreshSnapshot({ asOf: '2026-11-16T09:00:00Z' }, fixedNow), true);
assert.equal(shouldRefreshSnapshot({ ...snapshot, rebuildRequired: true }, fixedNow), true);
assert.equal(shouldRefreshSnapshot({ asOf: '2026-11-17T09:06:00Z' }, fixedNow), true);
const stale = { ...snapshot, asOf: new Date(Date.now() - 25 * 60 * 60 * 1_000).toISOString() };
let refreshJob, refreshWakes = 0;
const staleHit = interaction();
await createWalletHandler({ ...base, readSnapshot: async () => stale,
  enqueueScan: async job => { refreshJob = job; return { accepted: true }; },
  wake: () => { refreshWakes++; },
})(staleHit);
assert.deepEqual(refreshJob, { wallet, threadId: 'thread-123', requesterId: userId,
  statusId: 'status-123', afterBlock: stale.through });
assert.equal(refreshWakes, 1);
assert.match(staleHit.messages.at(-1).content, new RegExp(`^拍拍 <@${userId}>`));
assert.match(staleHit.edits.at(-1), /快取需要更新.*背景工作/);
console.log('PASS stale cache replies immediately and schedules one bounded refresh');

const duplicateRefresh = interaction();
await createWalletHandler({ ...base, readSnapshot: async () => stale,
  enqueueScan: async () => ({ existingThreadId: 'older-thread' }),
})(duplicateRefresh);
assert.match(duplicateRefresh.edits.at(-1), /older-thread/);
assert.match(duplicateRefresh.messages.at(-1).content, new RegExp(`^拍拍 <@${userId}>`));
console.log('PASS repeated stale lookup reuses the existing refresh job');

process.env.DISCORD_WALLET_CHANNEL_ID = 'allowed-channel';
const wrong = interaction(); wrong.channelId = 'other-channel';
wrong.reply = async function(payload) { this.first = payload; };
await createWalletHandler(base)(wrong);
assert.match(wrong.first.content, /MOD 工具箱頻道/);
assert.equal(wrong.ackAt, undefined);
delete process.env.DISCORD_WALLET_CHANNEL_ID;

const denied = interaction();
denied.channel.threads.create = async () => { throw Object.assign(Error('missing thread permission'), { code: 50013 }); };
const oldError = console.error; console.error = () => {};
try { await createWalletHandler(base)(denied); } finally { console.error = oldError; }
assert.match(denied.edits.at(-1), /建立公開討論串/);
console.log('PASS channel and thread permissions');

process.env.DISCORD_ADMIN_ID = '872351254536405093';
let renderAttempts = 0;
const recoveredPoster = interaction();
const oldPosterError = console.error;
console.error = () => {};
try {
  await createWalletHandler({ ...base, readSnapshot: async () => snapshot,
    renderPoster: async () => {
      if (++renderAttempts === 1) throw Error('temporary renderer failure');
      return Buffer.from('PNG');
    },
  })(recoveredPoster);
} finally { console.error = oldPosterError; }
assert.equal(renderAttempts, 2);
assert.match(recoveredPoster.messages.at(-1).content, new RegExp(`^拍拍 <@${userId}>`));
assert.ok(!recoveredPoster.messages.some(message => String(message.content).includes('872351254536405093')));
console.log('PASS cached poster first failure stays silent and retries');

renderAttempts = 0;
const failedPoster = interaction();
console.error = () => {};
try {
  await createWalletHandler({ ...base, readSnapshot: async () => snapshot,
    renderPoster: async () => { renderAttempts++; throw Error('renderer unavailable'); },
  })(failedPoster);
} finally { console.error = oldPosterError; }
assert.equal(renderAttempts, 2);
assert.match(failedPoster.edits.at(-1), /連續兩次未能傳送/);
assert.match(failedPoster.messages.at(-1).content, /<@872351254536405093>/);
assert.deepEqual(failedPoster.messages.at(-1).allowedMentions, { users: ['872351254536405093'] });
console.log('PASS cached poster second failure alerts only the MOD');

let cacheReads = 0;
const recoveredCache = interaction();
console.error = () => {};
try {
  await createWalletHandler({ ...base,
    readSnapshot: async () => {
      if (++cacheReads === 1) throw Error('temporary database failure');
      return snapshot;
    },
  })(recoveredCache);
} finally { console.error = oldPosterError; }
assert.equal(cacheReads, 2);
assert.match(recoveredCache.messages.at(-1).content, new RegExp(`^拍拍 <@${userId}>`));
console.log('PASS first cache read failure retries without notifying the requester');

cacheReads = 0;
const failedCache = interaction();
console.error = () => {};
try {
  await createWalletHandler({ ...base,
    readSnapshot: async () => { cacheReads++; throw Error('database unavailable'); },
  })(failedCache);
} finally { console.error = oldPosterError; }
assert.equal(cacheReads, 2);
assert.match(failedCache.edits.at(-1), /連續兩次無法讀取/);
assert.match(failedCache.messages.at(-1).content, /<@872351254536405093>/);
console.log('PASS second cache read failure alerts only the MOD');

let enqueueAttempts = 0, enqueueWakes = 0;
const recoveredEnqueue = interaction();
console.error = () => {};
try {
  await createWalletHandler({ ...base,
    enqueueScan: async () => {
      if (++enqueueAttempts === 1) throw Error('database response lost');
      return { accepted: false, existingThreadId: 'thread-123' };
    },
    wake: () => { enqueueWakes++; },
  })(recoveredEnqueue);
} finally { console.error = oldPosterError; }
assert.equal(enqueueAttempts, 2);
assert.equal(enqueueWakes, 1);
assert.match(recoveredEnqueue.edits.at(-1), /已排入背景掃描/);
console.log('PASS queue retry reuses the same thread after an ambiguous database response');
delete process.env.DISCORD_ADMIN_ID;
