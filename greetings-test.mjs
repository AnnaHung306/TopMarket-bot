import assert from 'node:assert/strict';
import { greetingFor, createGreetingHandler } from './discord-greetings.mjs';

const base = { guildId: '1541304826674155550', channelId: '1572821315507855430', author: { bot: false }, content: '' };
for (const word of ['早安', '午安', '晚安']) {
  assert.equal(greetingFor({ ...base, content: `<@123> ${word}` }, '123'), word);
  assert.equal(greetingFor({ ...base, content: `${word} <@!123>` }, '123'), word);
}
for (const extra of [
  { channelId: 'other', content: '<@123> 早安' },
  { guildId: 'other', content: '<@123> 早安' },
  { author: { bot: true }, content: '<@123> 早安' },
  { webhookId: 'x', content: '<@123> 早安' },
  { content: '<@456> 早安' }, { content: '早安' },
  { content: '<@123> 早安 晚安' }, { content: '<@123> 早安嗎' },
]) assert.equal(greetingFor({ ...base, ...extra }, '123'), null);
let result;
await createGreetingHandler({ user: { id: '123' } })({ ...base, content: '<@123> 早安', reply: async value => { result = value; } });
assert.deepEqual(result, { content: '早安', allowedMentions: { repliedUser: false, parse: [] } });
console.log('Greeting scope and reply tests passed');
