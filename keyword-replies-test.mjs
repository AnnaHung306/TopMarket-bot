import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { keywordFor, createKeywordReplyHandler } from './discord-keyword-replies.mjs';
import { createGreetingHandler } from './discord-greetings.mjs';

const entries = JSON.parse(await readFile(new URL('./assets/keyword-replies/manifest.json', import.meta.url)));
for (const entry of entries) {
  assert.match(entry.file, /^\d{2}\.gif$/);
  assert.match(entry.source, /^https:\/\/tenor\.com\//);
  assert.ok(entry.frames > 1);
  const data = await readFile(new URL(`./assets/keyword-replies/${entry.group}/${entry.file}`, import.meta.url));
  assert.ok(['GIF87a', 'GIF89a'].includes(data.subarray(0, 6).toString()));
  assert.equal(data.length, entry.bytes);
  assert.equal(createHash('sha256').update(data).digest('hex'), entry.sha256);
}
const base = { guildId: '1541304826674155550', channelId: '1572821315507855430', author: { id: '123', bot: false } };
const check = (text, expected) => assert.equal(keywordFor({ ...base, content: text }), expected, text);
for (const value of ['早安', '大家早安', '早上好', '大家早上好', 'GM!', 'gM']) check(value, 'morning');
for (const value of ['今日開卡', '今日开卡']) check(value, 'opening');
for (const value of ['我虧錢了', '我今天亏钱了', '唉，我虧錢了！']) check(value, 'loss');
for (const value of ['早', '早就知道', '早點睡', '虧', '好虧', '虧錢', '他虧錢了', '如果我虧錢了', '我沒有虧錢', '我朋友虧錢了', '我虧錢了嗎？', 'gaming', 'telegram', 'https://example.com/gm']) check(value, null);
for (const changes of [{channelId:'123'}, {guildId:'123'}, {author:{id:'123',bot:true}}, {webhookId:'123'}, {system:true}]) assert.equal(keywordFor({...base,...changes,content:'早安'}),null);
let sent;
await createKeywordReplyHandler({ random: () => 0 })({ ...base, content: '早安', reply: async x => { sent = x; } });
assert.equal(sent.content, '<@123> 早安喵~ 新的一天又開始了！');
assert.deepEqual(sent.allowedMentions, { parse: [], users: ['123'], repliedUser: false });
assert.match(sent.files[0].attachment, /morning[\\/]01\.gif$/);
await createKeywordReplyHandler({ random: () => 0.999 })({ ...base, content: '今日開卡', reply: async x => { sent = x; } });
assert.match(sent.files[0].attachment, /opening[\\/]05\.gif$/);
sent = null;
await createKeywordReplyHandler({ canAct: async () => false })({ ...base, content:'早安', reply: async x => { sent = x; } });
assert.equal(sent, null);
await createGreetingHandler({user:{id:'999'}}, {suppressMorning:true})({...base,content:'<@999> 早安',reply:async x => {sent=x;}});
assert.equal(sent, null);
console.log('Keyword replies, privacy scope and 13 GIF assets verified');
