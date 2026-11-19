import assert from 'node:assert/strict';
import { classifyScamTest, createScamTestHandler } from './discord-scam-test.mjs';
const base = { guildId: '1541304826674155550', channelId: '1572821315507855430', author: { id: '123', bot: false } };
const positives = [
  '我不小心檢舉你，快加客服好友申訴',
  'I accidentally reported you, add me as a friend to contact support',
  '恭喜獲得 NFT 白名單，連接錢包領取 https://example.invalid',
  'Free Nitro https://example.invalid', 'verify your wallet https://example.invalid',
  '請輸入助記詞', '我要買你的 NFT，先支付中介手續費',
  '加我好友下載遊戲測試版', '你的資產可以追回，先支付驗證費',
];
const negatives = [
  '早安', '加我好友一起玩', 'add me as a friend', '今天有空投活動嗎？',
  'https://example.invalid', '如何防範詐騙？', 'NFT 交易的手續費怎麼計算？',
  '請勿輸入助記詞，這是詐騙', '不要加客服好友，這種誤檢舉是詐騙',
  'Never share your private key', '今天下載了遊戲，真好玩',
];
for (const content of positives) assert.ok(classifyScamTest({ ...base, content }), content);
for (const content of negatives) assert.equal(classifyScamTest({ ...base, content }), null, content);
assert.equal(classifyScamTest({ ...base, channelId: 'another', content: positives[0] }), null);
assert.equal(classifyScamTest({ ...base, author: { bot: true }, content: positives[0] }), null);
assert.equal(classifyScamTest({ ...base, webhookId: '123', content: positives[0] }), null);
let deleted = false, alert;
await createScamTestHandler()({ ...base, content: positives[0], delete: async () => { deleted = true; }, channel: { send: async value => { alert = value; } } });
assert.ok(deleted); assert.match(alert.content, /疑似詐騙/); assert.match(alert.content, /已刪除/); assert.deepEqual(alert.allowedMentions, { parse: [] });
await createScamTestHandler()({ ...base, content: positives[0], delete: async () => { throw Error('no permission'); }, channel: { send: async value => { alert = value; } } });
assert.match(alert.content, /刪除失敗/);
console.log('Scam test scope, examples, deletion and alert tests passed');
