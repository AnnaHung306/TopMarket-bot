import assert from 'node:assert/strict';
import { formatReport, getReport } from './discord-report.mjs';
import { summarizeWalletEvents } from './worker/report/accounting.js';
import { renderPoster } from './discord-poster.mjs';
import { createWalletHandler } from './discord-interaction.mjs';

const wallet = '0x' + 'a'.repeat(40);
const totals = summarizeWalletEvents([]);
totals.pack = '1234567'; totals.sales = '5000000'; totals.pendingPacks = '1';
const old = { start: 1, through: 10, asOf: '2026-01-01', totals };
const updated = { ...old, through: 20 };
const calls = [];
const pages = [{ ready: true, cached: true, snapshot: old }, { ready: false, progress: { through: 15, target: 20 } }, { ready: true, cached: false, snapshot: updated }];
const result = await getReport(wallet, async (address, after) => { calls.push([address, after]); return pages.shift(); }, async () => {});
assert.equal(result.snapshot.through, 20);
assert.deepEqual(calls.map(c => c[1]), [undefined, 10, 10]);
const report = formatReport(wallet, updated);
assert.match(report, /抽卡花費（已核實）：1\.234567 USDC/);
assert.match(report, /已識別淨收支：3\.765433 USDC/);
assert.match(report, /1 筆事件待核對/);
assert.match(report, /不含持倉估值/);
const image = renderPoster(wallet, updated);
assert.deepEqual([...image.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
assert.ok(image.length > 10000);
const responses = [], threadMessages = [], statusEdits = [];
const thread = { async send(payload) { threadMessages.push(payload); return { async edit(value) { statusEdits.push(value); } }; } };
const interaction = {
  isChatInputCommand: () => true, commandName: 'wallet', options: { getString: () => wallet },
  user: { id: '123456789012345678', username: 'test-user' }, member: { displayName: '測試用戶' },
  async deferReply() { this.deferred = true; },
  async editReply(options) { this.replied = true; responses.push(options); },
  async fetchReply() { return { async startThread(options) { assert.equal(options.name, '測試用戶 錢包報表查詢'); return thread; } }; },
};
const handler = createWalletHandler({ readSnapshot: async () => updated, reserveScan: async () => { throw Error('cache must not consume quota'); }, readPage: async () => { throw Error('cache must not call RPC'); }, renderPoster, formatReport, configured: () => true });
await handler(interaction);
assert.equal(responses[0].content, '貓貓正在努力工作，請稍後...');
assert.equal(responses[0].files[0].name, 'cat-wait.gif');
assert.deepEqual([...responses[0].files[0].attachment.subarray(0, 6)], [71, 73, 70, 56, 57, 97]);
assert.equal(threadMessages[0].files[0].name, 'cat-wait.gif');
assert.match(threadMessages[2].content, /^<@123456789012345678>\n/);
assert.deepEqual(threadMessages[2].allowedMentions, { users: ['123456789012345678'] });
assert.match(threadMessages[2].content, /3\.765433 USDC/);
assert.equal(threadMessages[2].files[0].name, 'wallet-report.png');
assert.deepEqual([...threadMessages[2].files[0].attachment.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
assert.match(statusEdits[0], /已完成/);
console.log('Discord report tests passed');
