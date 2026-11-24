// Controller/storage regression only. No Discord request is sent by this test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { FileLedgerStore } from '../store.mjs';
import { recoverInterruptedReports } from '../recovery.mjs';
import { draftPayload } from '../discord.mjs';

test('startup repairs a pre-fix interrupted loading message once and retains its owner, address and selection', async () => {
  const store = new FileLedgerStore('work/wallet-v2/verification/recovery/' + randomBytes(8).toString('hex'));
  const view = await store.saveView({ id: randomBytes(16).toString('hex'), phase: 'draft', channelId: 'thread', messageId: 'report',
    ownerId: 'owner', wallet: '0x' + '1'.repeat(40), selection: { scope: 'upgrade', period: 'all', detail: 'summary' } });
  let edits = 0;
  const message = { author: { id: 'bot' }, content: 'loading...', components: [], attachments: new Map(),
    async edit(payload) { edits++; Object.assign(this, payload); } };
  const client = { user: { id: 'bot' }, channels: { fetch: async () => ({ messages: { fetch: async () => message } }) } };
  const logger = { info() {}, error() {} };
  const result = await recoverInterruptedReports({ client, viewStore: store, draftPayload, logger });
  assert.equal(result.recovered, 1); assert.equal(edits, 1); assert.match(message.content, /查詢中斷/);
  const saved = await store.loadView(view.id);
  assert.equal(saved.ownerId, view.ownerId); assert.equal(saved.wallet, view.wallet);
  assert.deepEqual(saved.selection, view.selection); assert.equal(saved.phase, 'draft'); assert.equal(saved.revision, view.revision + 1);
  assert.ok(message.components.flatMap(row => row.toJSON().components).some(row => row.custom_id?.endsWith(':refresh')));
  assert.equal((await recoverInterruptedReports({ client, viewStore: store, draftPayload, logger })).recovered, 0);
  assert.equal(edits, 1);
});

test('startup leaves drafts, ready reports and messages authored by someone else unchanged', async () => {
  const store = new FileLedgerStore('work/wallet-v2/verification/recovery-untouched/' + randomBytes(8).toString('hex'));
  const messages = new Map();
  for (const [phase, content, author] of [['draft', '選項已變更，請按「更新資料」。', 'bot'], ['ready', 'real report', 'bot'], ['loading', 'loading...', 'other']]) {
    const id = randomBytes(16).toString('hex');
    await store.saveView({ id, phase, channelId: 'thread', messageId: id });
    messages.set(id, { author: { id: author }, content, components: [], attachments: new Map(), edit() { throw Error('must not edit'); } });
  }
  const client = { user: { id: 'bot' }, channels: { fetch: async () => ({ messages: { fetch: async id => messages.get(id) } }) } };
  const result = await recoverInterruptedReports({ client, viewStore: store, draftPayload, logger: { info() {}, error() {} } });
  assert.equal(result.recovered, 0);
});
