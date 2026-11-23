// Offline controller checks only: no Discord login, REST request, registration or message is sent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { FileLedgerStore } from '../store.mjs';
import { upgradeDefinition } from '../registry.mjs';
import { decodeUpgradeLog, receiptTransfers } from '../upgrade.mjs';
import { createV2InteractionHandler, viewComponents } from '../discord.mjs';
const fixture = JSON.parse(await readFile(new URL('../fixtures/public-upgrades.json', import.meta.url)));
const definition = await upgradeDefinition(), pool = { ...definition, definition, supported: true };
const times = new Map(fixture.blocks.map(block => [Number(block.number), Number(block.timestamp)]));
const events = fixture.receipts.flatMap(receipt => receipt.logs.filter(log => log.address === pool.address)
  .map(log => decodeUpgradeLog(log, pool)).filter(Boolean)).filter(event => event.spinId === '148')
  .map(event => ({ ...event, timestamp: times.get(event.block), valueDecimals: 6 }));
const wallet = events.find(event => event.category === 'UpgradeRequested').player;
const ledger = { version: 1, wallet, catalog: [pool], cards: {}, events,
  transfers: fixture.receipts.flatMap(receipt => receiptTransfers(receipt, wallet)).map(t => ({ ...t, timestamp: times.get(t.block) })),
  coverage: { gavin: { status: 'verified', complete: true }, [pool.id]: { status: 'verified', complete: true } },
  warnings: [], asOf: '2026-11-23T00:00:00.000Z' };
async function harness({ toolbox = false, channelConfigured = true } = {}) {
  let queries = 0, threads = 0, renderHook, queryHook, controlPrefix;
  const history = [];
  const viewStore = new FileLedgerStore('work/wallet-v2/verification/offline-views');
  const service = { load: async () => structuredClone(ledger), query: async () => { queries++; await queryHook?.(); return { ledger: structuredClone(ledger) }; } };
  const resultMessage = { id: 'result-message', async edit(payload) {
    this.payload = payload; history.push(payload);
    const first = payload.components?.[0]?.toJSON().components[0].custom_id;
    if (first) controlPrefix = first.split(':').slice(0, -1).join(':');
    return this;
  } };
  const thread = { id: 'thread-1', parentId: 'toolbox', isThread: () => true, async send(payload) { resultMessage.initial = payload; return resultMessage; } };
  const channel = toolbox ? { id: 'toolbox', isThread: () => false, threads: { async create() { threads++; return thread; } } } : thread;
  const createHandler = () => createV2InteractionHandler({ service, viewStore, channelId: () => channelConfigured ? 'toolbox' : '',
    renderPoster: async report => renderHook ? renderHook(report) : Buffer.from('offline-controller-payload'), logger: { info() {}, error() {} } });
  const handler = createHandler();
  const interaction = { commandName: 'wallet', id: 'command', channel, channelId: channel.id,
    isChatInputCommand: () => true, isAutocomplete: () => false, user: { id: 'owner', username: 'test' },
    options: { getString: key => ({ address: wallet, scope: 'upgrade' })[key] ?? null },
    async reply(payload) { this.replyPayload = payload; this.replied = true; },
    async deferReply() { this.deferred = true; }, async editReply(payload) {
      this.editPayload = payload; return toolbox ? { id: 'toolbox-status' } : resultMessage.edit(payload);
    } };
  await handler(interaction);
  const id = resultMessage.payload?.components[0].toJSON().components[0].custom_id.split(':')[1];
  function component(action, values = [], userId = 'owner') {
    return { customId: `${controlPrefix}:${action}`, message: resultMessage, channel: thread, channelId: thread.id,
      isChatInputCommand: () => false, isAutocomplete: () => false, user: { id: userId }, values,
      async reply(payload) { this.replyPayload = payload; this.replied = true; },
      async deferReply() { this.deferred = true; this.ephemeral = true; }, async deferUpdate() { this.deferred = true; },
      async update(payload) { this.replied = true; return resultMessage.edit(payload); },
      async followUp(payload) { this.followUpPayload = payload; }, async editReply(payload) {
        this.editPayload = payload; if (!this.ephemeral) return resultMessage.edit(payload);
      },
      async showModal(modal) { this.modal = modal.toJSON(); } };
  }
  return { handler, createHandler, interaction, component, viewStore, resultMessage, id,
    history, get queries() { return queries; }, get threads() { return threads; },
    setRenderHook(hook) { renderHook = hook; }, setQueryHook(hook) { queryHook = hook; } };
}
test('offline existing-thread path edits its report directly; toolbox path creates exactly one thread', async () => {
  const inThread = await harness();
  assert.equal(inThread.threads, 0); assert.equal(inThread.queries, 1);
  assert.equal(inThread.resultMessage.payload.files[0].name, 'wallet-v2.png');
  assert.equal(inThread.resultMessage.payload.components.length, 3);
  const toolbox = await harness({ toolbox: true });
  assert.equal(toolbox.threads, 1); assert.equal(toolbox.queries, 1);
});
test('offline missing channel config rejects before any query or thread', async () => {
  const h = await harness({ channelConfigured: false });
  assert.equal(h.queries, 0); assert.equal(h.threads, 0);
  assert.match(h.interaction.replyPayload.content, /工具箱/);
});
test('offline controls isolate the owner and perform filter-only changes without RPC', async () => {
  const h = await harness();
  const denied = h.component('detail', [], 'other-member');
  await h.handler(denied);
  assert.match(denied.replyPayload.content, /其他成員/);
  const detail = h.component('detail'); await h.handler(detail);
  assert.equal((await h.viewStore.loadView(h.id)).selection.detail, 'detail');
  await h.handler(h.component('detail'));
  assert.equal((await h.viewStore.loadView(h.id)).selection.detail, 'summary');
  await h.handler(h.component('period', ['7d']));
  await h.handler(h.component('dimension'));
  assert.equal(h.queries, 1);
  assert.equal((await h.viewStore.loadView(h.id)).selection.dimension, 'location');
});
test('offline modal dates validate before saving; state survives a new controller', async () => {
  const h = await harness();
  const open = h.component('period', ['custom']); await h.handler(open);
  assert.equal(open.modal.title, '自訂日期（台灣時間）');
  const bad = h.component('dates-submit');
  bad.fields = { getTextInputValue: key => key === 'from' ? '2026-02-29' : '2026-03-01' };
  await h.handler(bad);
  assert.ok(bad.replyPayload || bad.followUpPayload);
  assert.equal((await h.viewStore.loadView(h.id)).selection.period, 'all');
  const good = h.component('dates-submit');
  good.fields = { getTextInputValue: key => key === 'from' ? '2026-11-20' : '2026-11-22' };
  await h.createHandler()(good);
  const saved = await h.viewStore.loadView(h.id);
  assert.equal(saved.selection.from, '2026-11-20'); assert.equal(saved.selection.period, 'custom');
  assert.equal(h.queries, 1);
});
test('offline downloads do not mutate the visible report; refresh explicitly requests fresh data', async () => {
  const h = await harness();
  const before = await h.viewStore.loadView(h.id);
  const csv = h.component('csv'); await h.handler(csv);
  assert.equal(csv.editPayload.files[0].name, 'wallet-v2.csv');
  assert.deepEqual(await h.viewStore.loadView(h.id), before);
  assert.equal(h.queries, 1);
  await h.handler(h.component('refresh'));
  assert.equal(h.queries, 2);
});
test('offline duplicate click cannot release another operation lock or overwrite its filter', async () => {
  const h = await harness(); let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  h.setRenderHook(async () => { entered(); return new Promise(resolve => { release = () => resolve(Buffer.from('offline-payload')); }); });
  const first = h.handler(h.component('detail')); await ready;
  const second = h.component('dimension'); await h.handler(second);
  const third = h.component('dimension'); await h.handler(third);
  assert.match(second.replyPayload.content, /上一個操作/); assert.match(third.replyPayload.content, /上一個操作/);
  release(); await first;
  const view = await h.viewStore.loadView(h.id);
  assert.equal(view.selection.detail, 'detail'); assert.equal(view.selection.dimension, 'location');
});
test('upgrade controls never offer pack/source/search inputs, including a persisted origin view', () => {
  const pack = { id: 'pack:' + '0x' + '1'.repeat(40), kind: 'packs', name: 'Starter Pack', address: '0x' + '1'.repeat(40) };
  const rows = viewComponents({ ...ledger, catalog: [...ledger.catalog, pack] }, { id: 'a'.repeat(32), selection: {
    scope: 'upgrade', poolId: pack.id, dimension: 'origin', period: 'all', detail: 'summary' } }).map(row => row.toJSON());
  const ids = rows.flatMap(row => row.components.map(component => component.custom_id.split(':').at(-1)));
  assert.deepEqual(ids, ['scope', 'period', 'detail', 'png', 'csv', 'refresh']);
  assert.equal(rows.length, 3);
});
test('small pack lists show names without contract descriptions or unused navigation', () => {
  const pack = { id: 'pack:' + '0x' + '1'.repeat(40), kind: 'packs', name: 'Starter Pack', address: '0x' + '1'.repeat(40), enabled: false };
  const rows = viewComponents({ ...ledger, catalog: [pack] }, { id: 'a'.repeat(32), selection: {
    scope: 'packs', period: 'all', detail: 'summary' } }).map(row => row.toJSON());
  assert.equal(rows.length, 4);
  const options = rows[1].components[0].options;
  assert.equal(options[1].label, 'Starter Pack'); assert.equal(options[1].description, '已結束');
  assert.ok(options.every(option => !/0x/i.test(option.label + (option.description || ''))));
  assert.ok(rows.flatMap(row => row.components).every(component => !/search|previous|next|dimension/.test(component.custom_id)));
});
test('refresh immediately removes the old report before a delayed query and publishes text/PNG together', async () => {
  const h = await harness(); let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  h.setQueryHook(() => new Promise(resolve => { release = resolve; entered(); }));
  const operation = h.handler(h.component('refresh')); await started;
  const pending = h.resultMessage.payload;
  assert.equal(pending.content, 'loading...');
  assert.deepEqual(pending.attachments, []); assert.deepEqual(pending.files, []);
  assert.deepEqual(pending.components, []);
  release(); await operation;
  assert.match(h.resultMessage.payload.content, /Top.Market/);
  assert.equal(h.resultMessage.payload.files[0].name, 'wallet-v2.png');
  assert.equal(h.history.filter(body => body.content === 'loading...').length, 2, 'initial query plus explicit refresh');
});
test('failure leaves no old PNG and retry preserves the requested period', async () => {
  const h = await harness();
  h.setRenderHook(async () => { throw Error('simulated render failure'); });
  await h.handler(h.component('period', ['7d']));
  assert.match(h.resultMessage.payload.content, /讀取失敗/);
  assert.deepEqual(h.resultMessage.payload.attachments, []); assert.deepEqual(h.resultMessage.payload.files, []);
  assert.equal((await h.viewStore.loadView(h.id)).selection.period, '7d');
  assert.equal(h.resultMessage.payload.components[0].toJSON().components[0].label, '重試');
  h.setRenderHook(); await h.handler(h.component('refresh'));
  assert.match(h.resultMessage.payload.content, /近 7 天/);
  assert.equal(h.resultMessage.payload.files[0].name, 'wallet-v2.png');
});
test('late clicks from older controls cannot overwrite a newer report or start a delayed refresh', async () => {
  const h = await harness(), late = h.component('refresh');
  await h.handler(h.component('detail'));
  const completed = h.resultMessage.payload, count = h.history.length;
  await h.handler(late);
  assert.match(late.replyPayload.content, /最新/);
  const legacy = h.component('refresh'); legacy.customId = `wv2:${h.id}:refresh`;
  await h.handler(legacy);
  assert.match(legacy.replyPayload.content, /最新/);
  assert.strictEqual(h.resultMessage.payload, completed); assert.equal(h.history.length, count);
  assert.equal(h.queries, 1);
});
test('existing unversioned reports migrate on their next real action', async () => {
  const h = await harness(), saved = await h.viewStore.loadView(h.id);
  delete saved.controlsVersion;
  await h.viewStore.saveView(saved, saved.revision);
  const legacy = h.component('refresh'); legacy.customId = `wv2:${h.id}:refresh`;
  await h.handler(legacy);
  const migrated = await h.viewStore.loadView(h.id);
  assert.equal(migrated.controlsVersion, 1); assert.equal(h.queries, 2);
  assert.match(h.resultMessage.payload.components[0].toJSON().components[0].custom_id, new RegExp(`:${migrated.revision}:scope$`));
});
test('a failed PNG download clears its own loading reply without changing the visible report', async () => {
  const h = await harness(), original = h.resultMessage.payload;
  h.setRenderHook(async () => { throw Error('simulated download failure'); });
  const download = h.component('png'); await h.handler(download);
  assert.match(download.editPayload.content, /下載失敗/);
  assert.deepEqual(download.editPayload.attachments, []); assert.deepEqual(download.editPayload.files, []);
  assert.strictEqual(h.resultMessage.payload, original);
});
