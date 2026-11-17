import assert from 'node:assert/strict';
import { createWalletHandler } from './discord-interaction.mjs';

const wallet = '0x' + 'a'.repeat(40), userId = '123456789012345678';
const snapshot = { through: 99 };

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
