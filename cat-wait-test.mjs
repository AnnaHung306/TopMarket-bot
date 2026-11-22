import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createWalletHandler } from './discord-interaction.mjs';

const entries = JSON.parse(await readFile(new URL('./assets/tenor-cat-wait/manifest.json', import.meta.url), 'utf8'));
assert.deepEqual(entries.map(entry => entry.file).sort(), ['cat-01.gif', 'cat-03.gif', 'cat-05.gif', 'cat-06.gif', 'cat-11.gif', 'cat-12.gif', 'cat-17.gif', 'cat-18.gif', 'cat-19.gif']);
for (const [index, entry] of entries.entries()) {
  const replies = [], messages = [], edits = [];
  const thread = { async send(payload) { messages.push(payload); return { async edit(text) { edits.push(text); } }; } };
  const interaction = {
    commandName: 'wallet', isChatInputCommand: () => true, options: { getString: () => 'invalid' },
    user: { id: '123', username: 'test' },
    async deferReply() { this.deferred = true; },
    async editReply(payload) { replies.push(payload); this.replied = true; },
    channel: { threads: { async create() { return { ...thread, id: 'thread-123' }; } } },
  };
  const handler = createWalletHandler({ chooseWaitingIndex: () => index, configured: () => true });
  await handler(interaction);
  const initial = replies[0];
  assert.equal(createHash('sha256').update(initial.files[0].attachment).digest('hex'), entry.sha256);
  assert.equal(replies[1].content, `${initial.content}\n進度與報表請見 <#thread-123>`);
  assert.deepEqual(messages, ['正在核對錢包收支，完成後會在此通知。']);
  assert.match(edits[0], /有效的 Base 錢包地址/);
  assert.equal(initial.content, '貓貓正在努力工作，請稍後... 完成後會拍拍通知');
  assert.ok(!/https?:\/\//.test(replies[1].content), `${entry.file} exposed an external link`);
}
console.log(`PASS: ${entries.length} GIF choices only in the channel reply`);
