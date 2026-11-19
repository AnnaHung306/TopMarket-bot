import assert from 'node:assert/strict';
import { classifyScamTest, createScamTestHandler } from './discord-scam-test.mjs';
const base = { guildId: '1541304826674155550', channelId: '1572821315507855430', author: { id: '123', bot: false } };
for (const content of ['加我好友', 'add me as a friend', 'Free Nitro https://example.invalid', 'verify your wallet https://example.invalid', '請提供助記詞']) {
  assert.ok(classifyScamTest({ ...base, content }), content);
}
for (const content of ['早安', '今天有空投活動嗎？', 'https://example.invalid', '如何防範詐騙？']) assert.equal(classifyScamTest({ ...base, content }), null, content);
assert.equal(classifyScamTest({ ...base, channelId: 'another', content: '加我好友' }), null);
assert.equal(classifyScamTest({ ...base, author: { bot: true }, content: '加我好友' }), null);
let deleted = false, alert;
await createScamTestHandler()({ ...base, content: '加我好友', delete: async () => { deleted = true; }, channel: { send: async value => { alert = value; } } });
assert.ok(deleted); assert.match(alert.content, /疑似詐騙/); assert.match(alert.content, /已刪除/); assert.deepEqual(alert.allowedMentions, { parse: [] });
await createScamTestHandler()({ ...base, content: '加我好友', delete: async () => { throw Error('no permission'); }, channel: { send: async value => { alert = value; } } });
assert.match(alert.content, /刪除失敗/);
console.log('Scam test scope, examples, deletion and alert tests passed');
