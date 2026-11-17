import assert from 'node:assert/strict';
import { createWalletHandler } from './discord-interaction.mjs';
import { createWalletQuery } from './discord-wallet-query.mjs';

const address = '0x' + 'a'.repeat(40);
const snapshot = { through: 99, asOf: new Date().toISOString() };
const poster = Buffer.from('test PNG');

function interaction(wallet = address, userId = '123456789012345678') {
  const edits = [], messages = [], replies = [];
  const thread = {
    id: userId,
    async send(payload) {
      messages.push(payload);
      return { async edit(value) { edits.push(value); } };
    },
  };
  return {
    id: userId, commandName: 'wallet', isChatInputCommand: () => true,
    options: { getString: () => wallet }, channelId: 'allowed-channel',
    user: { id: userId, username: 'test-user' }, member: { displayName: '測試用戶' },
    edits, messages, replies,
    async deferReply() { this.deferred = true; },
    channel: { threads: { async create(options) {
      assert.equal(options.name, '測試用戶 錢包報表查詢');
      return thread;
    } } },
    async reply(payload) { replies.push(payload); },
    async editReply(payload) { assert.equal(this.deferred, true); replies.push(payload); },
  };
}

const base = { configured: () => true, chooseWaitingIndex: () => 0,
  queryWallet: async () => { throw Error('unexpected query'); },
  renderPoster: () => poster, formatReport: () => '摘要' };

process.env.DISCORD_WALLET_CHANNEL_ID = 'allowed-channel';
try {
  const wrong = interaction(); wrong.channelId = 'other-channel';
  await createWalletHandler(base)(wrong);
  assert.match(wrong.replies[0].content, /MOD 工具箱頻道/);
  assert.equal(wrong.deferred, undefined);

  const bad = interaction('invalid');
  await createWalletHandler(base)(bad);
  assert.match(bad.edits.at(-1), /有效的 Base 錢包地址/);

  const missing = interaction();
  await createWalletHandler({ ...base, configured: () => false })(missing);
  assert.match(missing.edits.at(-1), /尚未完成設定/);
} finally {
  delete process.env.DISCORD_WALLET_CHANNEL_ID;
}

const denied = interaction();
denied.channel.threads.create = async () => { throw Object.assign(Error('missing thread permission'), { code: 50013 }); };
const originalError = console.error;
try {
  console.error = () => {};
  await createWalletHandler(base)(denied);
  assert.match(denied.replies.at(-1), /建立公開討論串/);

  let attempts = 0;
  const failed = interaction();
  const queryWallet = createWalletQuery(async () => {
    if (++attempts === 1) throw Error('temporary upstream failure');
    return { ready: true, snapshot };
  });
  const handler = createWalletHandler({ ...base, queryWallet });
  await handler(failed);
  assert.match(failed.edits.at(-1), /無法完成鏈上查詢/);
  assert.equal(failed.messages.length, 1);
  assert.equal(attempts, 1);
  await handler(interaction());
  assert.equal(attempts, 2);
} finally {
  console.error = originalError;
}

// Hold the first wallet's provider response while additional wallets finish.
const firstQueryStarted = Promise.withResolvers(), pending = Promise.withResolvers();
const seen = [];
const queryWallet = createWalletQuery(async wallet => {
  seen.push(wallet);
  if (wallet === address) {
    firstQueryStarted.resolve();
    await pending.promise;
  }
  return { ready: true, snapshot };
});
const joined = Promise.withResolvers();
const handler = createWalletHandler({ ...base, queryWallet(wallet, id) {
  const query = queryWallet(wallet, id);
  if (id === 'second') joined.resolve();
  return query;
} });
const first = interaction(address, 'first');
const second = interaction(address, 'second');
const firstDelivery = handler(first);
await firstQueryStarted.promise;
const secondDelivery = handler(second);
await joined.promise;
const others = Array.from({ length: 9 }, (_, i) => interaction('0x' + String(i).repeat(40), 'other-' + i));
await Promise.all(others.map(handler));
assert.equal(seen.length, 10);
assert.equal(seen.filter(wallet => wallet === address).length, 1);
assert.equal(first.messages.length, 1);
pending.resolve();
await Promise.all([firstDelivery, secondDelivery]);

for (const request of [first, second, ...others]) {
  assert.equal(request.replies[0].content, '貓貓正在努力工作，請稍後... 完成後會拍拍通知');
  assert.equal(request.replies[0].files[0].name, 'cat-wait.gif');
  assert.ok(request.replies[1].content.includes('<#' + request.user.id + '>'));
  assert.equal(request.messages.length, 2);
  const report = request.messages[1];
  assert.equal(report.content, '拍拍 <@' + request.user.id + '>\n摘要');
  assert.deepEqual(report.allowedMentions, { users: [request.user.id] });
  assert.deepEqual(report.files, [{ attachment: poster, name: 'wallet-report.png' }]);
  assert.match(request.edits.at(-1), /已完成/);
}
console.log('Discord guard, failure recovery and concurrent delivery tests passed');
