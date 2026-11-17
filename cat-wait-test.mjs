import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createWalletHandler } from './discord-interaction.mjs';

const entries = JSON.parse(await readFile(new URL('./assets/tenor-cat-wait/manifest.json', import.meta.url), 'utf8'));
assert.ok(entries.length >= 20);
for (const [index, entry] of entries.entries()) {
  const replies = [], messages = [], edits = [];
  const thread = { async send(payload) { messages.push(payload); return { async edit(text) { edits.push(text); } }; } };
  const interaction = {
    commandName: 'wallet', isChatInputCommand: () => true, options: { getString: () => 'invalid' },
    user: { id: '123', username: 'test' },
    async deferReply() { this.deferred = true; },
    async editReply(payload) { replies.push(payload); this.replied = true; },
    async fetchReply() { return { async startThread() { return thread; } }; },
  };
  const handler = createWalletHandler({ chooseWaitingIndex: () => index, configured: () => true });
  await handler(interaction);
  const initial = replies[0], threadMessage = messages[0];
  assert.equal(createHash('sha256').update(initial.files[0].attachment).digest('hex'), entry.sha256);
  assert.deepEqual(initial.files[0].attachment, threadMessage.files[0].attachment);
  assert.match(edits[0], /有效的 Base 錢包地址/);
  for (const text of [initial.content, threadMessage.content]) assert.ok(text.includes(entry.source), `${entry.file} missing source`);
}
console.log(`PASS: ${entries.length} choices, matching attachments and attribution`);
