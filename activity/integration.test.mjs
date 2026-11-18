import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, unlinkSync, rmdirSync, fsyncSync, readFileSync, appendFileSync } from 'node:fs';
import { resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createActivityModule } from './index.mjs';
import { ActivityJournal } from './journal.mjs';
import { ActivityApi } from './api.mjs';
import { ActivityWorker } from './worker.mjs';
import { canonicalize, makeSourceEnvelope, sourceGenesis, submissionFingerprint } from './protocol.mjs';
import { activityConfig } from './config.mjs';

const repo = resolve(fileURLToPath(new URL('..', import.meta.url))), fixtureDir = resolve(repo, 'activity/.test-fixtures');
const fixture = resolve(fixtureDir, 'activity-journal.ndjson');
const G = '12345678901234567', C = '22345678901234567', R = '32345678901234567', U = '42345678901234567', OTHER = '52345678901234567', B = '62345678901234567', S = '92345678901234567';
const T = '11111111-1111-4111-8111-111111111111', A = '22222222-2222-4222-8222-222222222222', RES = '33333333-3333-4333-8333-333333333333';
const env = { ACTIVITY_SCOPE: 'test', ACTIVITY_GUILD_ID: G, ACTIVITY_CHANNEL_ID: C, ACTIVITY_SUPPORT_CATEGORY_ID: S, ACTIVITY_MODERATOR_ROLE_ID: R,
  ACTIVITY_API_ORIGIN: 'http://127.0.0.1:8789', ACTIVITY_API_TOKEN: 'test-only-non-secret-token-at-least-32', ACTIVITY_PUBLIC_ORIGIN: 'http://127.0.0.1:8787' };
const quiet = { warn() {}, error() {} };
function harness() {
  let clock = Date.parse('2026-11-18T12:00:00Z'), count = 0;
  const cutoff = new Date(clock).toISOString();
  const task = { id: T, activity_id: A, source: 'discord', enabled: true, guild_id: G, channel_id: C, name: 'Fixture task' };
  const state = { offline: false, maintenance: false, requests: [], deliveries: [], coverage: [], reservations: new Map(), receipts: new Map(), accepted: '0', hash: null, lease: null, registeredAt: new Date(clock - 1000).toISOString(), status: 'queued', lostResponse: false, wrongScope: false, partialOnce: false };
  const channels = new Map();
  const parent = { id: C, type: 0, guildId: G, parentId: S, permissionsFor: () => ({ has: () => true }), threads: {
    create: async body => {
      const id = String(72345678901234567n + BigInt(++count));
      const thread = { id, name: body.name, type: 12, guildId: G, parentId: C, ownerId: B, url: 'https://discord.com/channels/' + G + '/' + id,
        archived: false, members: { add: async () => {} }, setInvitable: async value => { thread.invitable = value; }, setArchived: async value => { thread.archived = value; }, send: async body => { if (state.failNotification) throw Error('fixture private notification offline'); thread.sent ??= []; thread.sent.push(body); } };
      channels.set(id, thread); return thread;
    },
    fetchActive: async () => ({ threads: new Map([...channels].filter(([, value]) => value.type === 12 && !value.archived)) }),
    fetchArchived: async () => ({ threads: new Map([...channels].filter(([, value]) => value.type === 12 && value.archived)), hasMore: false }),
  } };
  channels.set(C, parent);
  channels.set(S, { id: S, type: 4, guildId: G, name: '📩SUPPORT' });
  const client = { user: { id: B }, channels: { fetch: async id => channels.get(id) }, isReady: () => true };
  const response = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = async (url, options) => {
    if (state.offline) throw Error('fixture offline');
    assert.equal(options.headers.authorization, 'Bearer ' + env.ACTIVITY_API_TOKEN);
    const path = new URL(url).pathname, body = options.body ? JSON.parse(options.body) : undefined;
    state.requests.push({ path, body });
    if (path === '/health') return response({ scope: state.wrongScope ? 'production' : 'test' });
    if (path === '/admission-state') {
      if (state.admissionStateOffline) throw Error('fixture admission status offline');
      return response(state.invalidAdmissionState ? {} : { accepting: !state.maintenance, observedAt: new Date(clock).toISOString() });
    }
    if (path === '/tasks') return response({ tasks: [task] });
    if (path === '/source/lease') {
      if (state.lease && state.lease.instanceId !== body.instanceId && Date.parse(state.lease.expiresAt) > clock) return response({ error: 'SOURCE_LEASE_BUSY' }, 409);
      if (BigInt(body.lastSequence) < BigInt(state.accepted)) return response({ error: 'SOURCE_JOURNAL_ROLLBACK' }, 409);
      state.hash ??= sourceGenesis(body.streamId, G, 'test');
      state.lease = { ...body, fence: '1', expiresAt: new Date(clock + 90_000).toISOString(), acceptedSequence: state.accepted, acceptedHash: state.hash, registeredAt: state.registeredAt };
      return response(state.lease);
    }
    if (path === '/threads/reserve') {
      if (state.maintenance) return response({ error: 'MAINTENANCE' }, 503);
      assert.equal(body.discord_user_id, U); assert.equal(body.guild_id, G); assert.equal(body.channel_id, C);
      const existing = state.reservations.get(RES);
      const reservation = existing ? { ...existing, created: false, task } : { id: RES, state: 'creating', created: true, thread_id: null, task };
      state.reservations.set(RES, reservation); return response({ reservation });
    }
    if (path === '/threads/' + RES + '/complete') { Object.assign(state.reservations.get(RES), { thread_id: body.thread_id, state: 'active' }); return response({ reservation: state.reservations.get(RES) }); }
    if (path === '/threads/' + RES + '/archive') { if (state.failArchive) return response({ error: 'fixture_archive_pending' }, 503); state.archived = true; return response({}); }
    if (path === '/threads/' + RES) return response({ reservation: state.reservations.get(RES) });
    if (path === '/source/events') {
      state.deliveries.push(body);
      if (state.failDelivery) return response({ results: [{ sequence: body.envelopes[0].sequence, error: 'SOURCE_STORAGE_UNAVAILABLE', retryable: true }], acceptedSequence: state.accepted, acceptedHash: state.hash });
      const results = [];
      for (const envelope of body.envelopes) {
        const old = state.receipts.get(envelope.sequence);
        if (old) { assert.equal(old.hash, envelope.hash); results.push(old.result); continue; }
        assert.equal(BigInt(envelope.sequence), BigInt(state.accepted) + 1n); assert.equal(envelope.previousHash, state.hash);
        if (state.partialOnce && results.length === 1) { state.partialOnce = false; results.push({ sequence: envelope.sequence, error: 'SOURCE_STORAGE_UNAVAILABLE', retryable: true }); break; }
        const result = envelope.payload.content === 'reject fixture' ? { sequence: envelope.sequence, source_event_id: envelope.payload.source_event_id, status: 'rejected', error: 'INVALID_SUBMISSION', retryable: false }
          : { sequence: envelope.sequence, source_event_id: envelope.payload.source_event_id, status: 'accepted', eventId: '44444444-4444-4444-8444-' + envelope.sequence.padStart(12, '0') };
        state.receipts.set(envelope.sequence, { hash: envelope.hash, result }); results.push(result); state.accepted = envelope.sequence; state.hash = envelope.hash;
      }
      if (state.lostResponse) { state.lostResponse = false; throw Error('fixture lost response after commit'); }
      return response({ results, acceptedSequence: state.accepted, acceptedHash: state.hash });
    }
    if (path === '/source/challenges') { state.onChallenge?.(); return response({ challenges: state.noChallenges ? [] : [{ id: '55555555-5555-4555-8555-555555555555', activityId: A, generation: '1', scopeHash: '0x' + '1'.repeat(64), cutoff }] }); }
    if (path === '/source/coverage') { state.coverage.push(body); return response({ status: 'ready' }); }
    if (path === '/events/status') return response({ events: body.ids.map(id => ({ id, status: state.status, reason: null })) });
    if (path === '/heartbeat') return response({});
    throw Error('Unexpected fixture endpoint: ' + path);
  };
  const module = (overrides = {}) => createActivityModule({ client, env: { ...env, ...overrides }, logger: quiet, fetchImpl, storagePath: fixture, now: () => clock });
  function interaction(sub, options = {}) {
    const replies = [], value = { id: String(82345678901234567n + BigInt(++count)), user: { id: U, bot: false }, guildId: G, channelId: C, member: { roles: [R] }, createdTimestamp: clock - 1,
      commandName: 'activity', isChatInputCommand: () => true, isModalSubmit: () => false,
      options: { getSubcommand: () => sub, getString: key => options[key] ?? null, getAttachment: key => options[key] ?? null },
      reply: async body => replies.push(body), deferReply: async body => replies.push({ ...body, processing: true }),
      editReply: async body => { if (options.notificationFails) throw Error('fixture notification lost'); replies.push(body); },
      showModal: async body => replies.push({ modal: body }), replies };
    return value;
  }
  const open = async mod => { const i = interaction('start', { task: T }); await mod.handleInteraction(i); const thread = [...channels.values()].find(c => c.type === 12); assert.ok(thread, JSON.stringify(i.replies)); return thread; };
  return { state, client, channels, module, interaction, open, fetchImpl, now: () => clock, advance: milliseconds => { clock += milliseconds; } };
}
function payload(id, content = 'Fixture submission') { return { source: 'discord', source_event_id: id, discord_user_id: U, activity_id: A, task_id: T, guild_id: G, channel_id: C, thread_id: '72345678901234568', event_at: '2026-11-18T12:00:00.000Z', content, evidence: [] }; }

test('existing-client activity host integration; isolated durable fixture only', async t => {
  assert.ok(fixture.startsWith(repo + sep)); assert.equal(dirname(fixture), fixtureDir);
  if (existsSync(fixtureDir)) throw Error('Refusing to replace a pre-existing activity test fixture directory');
  mkdirSync(fixtureDir);
  async function scenario(name, body) {
    await t.test(name, async () => { try { await body(); } finally { if (existsSync(fixture)) unlinkSync(fixture); } });
  }
  try {
    await scenario('disabled startup remains honest and unrelated /wallet is untouched', async () => {
      const h = harness(), mod = h.module(), request = h.interaction('status');
      await mod.handleInteraction(request); assert.match(request.replies[0].content, /尚未啟動/); assert.equal(h.state.requests.length, 0);
      request.commandName = 'wallet'; assert.equal(await mod.handleInteraction(request), false); await mod.stop();
    });
    await scenario('explicit category ID accepts emoji name without depending on its display text', async () => {
      const h = harness(), mod = h.module(); assert.equal(h.channels.get(S).name, '📩SUPPORT');
      await mod.start(); assert.equal(mod.state().available, true); await h.open(mod); await mod.stop();
    });
    await scenario('same category name cannot authorize the wrong parent ID', async () => {
      const h = harness(), mod = h.module(); h.channels.get(C).parentId = OTHER;
      h.channels.set(OTHER, { id: OTHER, type: 4, guildId: G, name: '📩SUPPORT' });
      await assert.rejects(mod.start(), error => error.code === 'ACTIVITY_SUPPORT_CATEGORY_CONFIG');
      const i = h.interaction('status'); await mod.handleInteraction(i); assert.match(i.replies[0].content, /尚未啟動/); assert.equal(h.state.requests.length, 0); await mod.stop();
    });
    await scenario('missing explicit category setting stays unavailable without using a name or legacy setting fallback', async () => {
      const h = harness(), mod = h.module({ ACTIVITY_SUPPORT_CATEGORY_ID: undefined, DISCORD_SUPPORT_CATEGORY_ID: S });
      assert.ok(mod.configurationErrors.includes('ACTIVITY_SUPPORT_CATEGORY_ID'));
      await assert.rejects(mod.start(), error => error.code === 'ACTIVITY_CONFIG_INVALID');
      const i = h.interaction('list'); await mod.handleInteraction(i); assert.match(i.replies[0].content, /ACTIVITY_SUPPORT_CATEGORY_ID/); assert.equal(h.state.requests.length, 0); assert.equal(existsSync(fixture), false); await mod.stop();
    });
    await scenario('guild, role, parent and thread ownership deny before reservation or source admission', async () => {
      const h = harness(), mod = h.module(); await mod.start(); const thread = await h.open(mod);
      for (const changes of [{ guildId: OTHER }, { member: { roles: [] } }, { channelId: OTHER }]) {
        const i = Object.assign(h.interaction('start', { task: T }), changes); await mod.handleInteraction(i); assert.match(i.replies.at(-1).content, /無法|指定活動/);
      }
      const other = h.interaction('submit', { text: 'private data' }); other.channelId = thread.id; other.user.id = OTHER;
      await mod.handleInteraction(other); assert.match(other.replies.at(-1).content, /自己的/); assert.equal(mod.state().pending, 0); assert.equal(h.state.deliveries.length, 0); await mod.stop();
    });
    await scenario('slash IDs, file evidence and fsync admission survive failed success notification; own status only', async () => {
      const h = harness(), mod = h.module(); await mod.start(); const thread = await h.open(mod);
      const i = h.interaction('submit', { text: 'Private original', evidence: { url: 'https://cdn.discordapp.com/attachments/1/file.png?ex=private', name: 'proof.png', contentType: 'image/png' }, notificationFails: true }); i.channelId = thread.id;
      await mod.handleInteraction(i); assert.equal(mod.state().pending, 1);
      const disk = readFileSync(fixture, 'utf8'); assert.ok(disk.includes('Private original')); assert.ok(disk.includes('"status":"unknown"'));
      const status = h.interaction('status'); await mod.handleInteraction(status); assert.match(status.replies.at(-1).content, new RegExp(i.id));
      const thief = h.interaction('status', { receipt: i.id }); thief.user.id = OTHER; await mod.handleInteraction(thief); assert.match(thief.replies.at(-1).content, /找不到屬於你/); assert.ok(!thief.replies.at(-1).content.includes('Private original'));
      await mod.flush(); const event = h.state.deliveries[0].envelopes[0].payload;
      assert.equal(event.source_event_id, i.id); assert.equal(event.discord_user_id, U); assert.equal(event.channel_id, C); assert.equal(event.thread_id, thread.id); assert.equal(event.task_id, T); assert.equal(event.activity_id, A);
      assert.equal(event.evidence[0].filename, 'proof.png'); assert.ok(event.evidence[0].url.includes('?ex=private')); assert.equal(mod.state().pending, 0);
      assert.equal(h.state.coverage.at(-1).capture.pendingBeforeCutoff, 0); assert.equal(h.state.coverage.at(-1).capture.localSequence, '1'); await mod.stop();
    });
    await scenario('API outage keeps durable admissions, expired lease stops new work; restart replays exactly once', async () => {
      const h = harness(); let mod = h.module(); await mod.start(); const thread = await h.open(mod);
      h.state.offline = true;
      const i = h.interaction('submit', { text: 'Outage original' }); i.channelId = thread.id; await mod.handleInteraction(i); assert.equal(mod.state().pending, 1);
      await mod.flush(); assert.equal(mod.state().pending, 1);
      h.advance(91_000); const late = h.interaction('submit', { text: 'Expired lease must not admit' }); late.channelId = thread.id; await mod.handleInteraction(late); assert.match(late.replies.at(-1).content, /尚未受理/); assert.equal(mod.state().pending, 1);
      await mod.stop(); h.state.offline = false; mod = h.module(); await mod.start(); await mod.flush(); assert.equal(h.state.receipts.size, 1); assert.equal(mod.state().pending, 0); await mod.stop();
    });
    await scenario('modal collects content with owner/nonce scope; parent cannot submit', async () => {
      const h = harness(), mod = h.module(); await mod.start(); const thread = await h.open(mod);
      const form = h.interaction('submit'); form.channelId = thread.id; await mod.handleInteraction(form); assert.equal(form.replies[0].modal.title, '提交活動任務');
      const submit = h.interaction('submit'); submit.channelId = thread.id; submit.isModalSubmit = () => true; submit.isChatInputCommand = () => false; submit.customId = form.replies[0].modal.custom_id; submit.fields = { getTextInputValue: () => 'Modal private content' };
      await mod.handleInteraction(submit); assert.equal(mod.state().pending, 1);
      await mod.handleInteraction(submit); assert.equal(mod.state().pending, 1); assert.match(submit.replies.at(-1).content, /過期/);
      const parent = h.interaction('submit', { text: 'Wrong place' }); await mod.handleInteraction(parent); assert.match(parent.replies.at(-1).content, /自己的/); await mod.stop();
    });
    await scenario('scope mismatch never registers a source and exposes no credentials', async () => {
      const h = harness(); h.state.wrongScope = true; const mod = h.module(); await assert.rejects(mod.start(), error => error.code === 'ACTIVITY_SCOPE_MISMATCH');
      assert.ok(h.state.requests.every(row => row.path === '/health')); const i = h.interaction('status'); await mod.handleInteraction(i); assert.match(i.replies[0].content, /尚未啟動/); assert.ok(!JSON.stringify(i.replies).includes(env.ACTIVITY_API_TOKEN)); await mod.stop();
    });
    await scenario('fsync failure is never admitted or sent; immutable first payload and damaged journal fail closed', async () => {
      let failSync = false;
      const journal = new ActivityJournal(fixture, { guildId: G, scope: 'test', fs: { syncAsync: async fd => { if (failSync) throw Error('fixture disk failure'); fsyncSync(fd); } } });
      const first = (await journal.admit(payload('original'))).receipt; assert.equal((await journal.admit(payload('original'))).duplicate, true);
      await assert.rejects(journal.admit(payload('original', 'replacement')), error => error.code === 'ACTIVITY_ORIGINAL_CONFLICT'); assert.equal(first.envelope.payload.content, 'Fixture submission');
      failSync = true; await assert.rejects(journal.admit(payload('not-confirmed')), error => error.code === 'ACTIVITY_JOURNAL_WRITE_FAILED'); assert.equal(journal.receipts.size, 1); assert.equal(journal.faulted, true); await journal.close();
      appendFileSync(fixture, '{partial'); assert.throws(() => new ActivityJournal(fixture, { guildId: G, scope: 'test' }), error => error.code === 'ACTIVITY_JOURNAL_CORRUPT');
    });
    await scenario('1,000 pending uses ten source batches + ten status calls; permanent business error cannot stall later receipts', async () => {
      const h = harness();
      const journal = new ActivityJournal(fixture, { guildId: G, scope: 'test' });
      const api = new ActivityApi({ scope: 'test', apiOrigin: env.ACTIVITY_API_ORIGIN, apiToken: env.ACTIVITY_API_TOKEN }, h.fetchImpl, h.now);
      const worker = new ActivityWorker({ journal, api, client: h.client, now: h.now, logger: quiet }); await worker.start();
      for (let n = 0; n < 1000; n++) await journal.admit(payload('bulk-' + n, n === 5 ? 'reject fixture' : 'Submission ' + n));
      await worker.flush(); assert.equal(h.state.deliveries.length, 10); assert.ok(h.state.deliveries.every(row => row.envelopes.length === 100)); assert.equal(h.state.receipts.size, 1000); assert.equal(journal.sourcePending().length, 0);
      const statusCalls = h.state.requests.filter(row => row.path === '/events/status'); assert.equal(statusCalls.length, 10); assert.ok(statusCalls.every(row => row.body.ids.length <= 100));
      assert.equal(h.state.receipts.get('6').result.status, 'rejected'); assert.equal(h.state.receipts.get('1000').result.status, 'accepted'); await worker.stop(); await journal.close();
    });
    await scenario('lost commit response and partial transient retry retain exact hashes; backoff cannot produce false coverage', async () => {
      const h = harness(), mod = h.module(); await mod.start(); const thread = await h.open(mod);
      for (let n = 0; n < 3; n++) { const i = h.interaction('submit', { text: 'Partial ' + n }); i.channelId = thread.id; await mod.handleInteraction(i); }
      h.state.partialOnce = true; await mod.flush(); assert.equal(mod.state().pending, 2); assert.equal(h.state.coverage.at(-1).capture.pendingBeforeCutoff, 2);
      assert.notEqual(h.state.coverage.at(-1).capture.localSequence, h.state.coverage.at(-1).throughSequence);
      h.advance(5000); h.state.lostResponse = true; await mod.flush(); assert.equal(mod.state().pending, 2); assert.equal(h.state.receipts.size, 3);
      h.advance(10_000); await mod.flush(); assert.equal(mod.state().pending, 0); assert.equal(h.state.receipts.size, 3); assert.equal(h.state.coverage.at(-1).capture.pendingBeforeCutoff, 0); await mod.stop();
    });
    await scenario('deterministic reservation recovery does not create duplicate threads after a lost create binding', async () => {
      const h = harness(); let mod = h.module(); await mod.start(); const thread = await h.open(mod); await mod.stop(); h.advance(91_000);
      h.state.reservations.get(RES).thread_id = null; h.state.reservations.get(RES).state = 'creating'; mod = h.module(); await mod.start();
      const again = h.interaction('start', { task: T }); await mod.handleInteraction(again); assert.equal([...h.channels.values()].filter(c => c.type === 12).length, 1); assert.ok(again.replies.at(-1).content.includes(thread.id)); await mod.stop();
    });
    await scenario('canonical JSON rejects lossy values and existing hash cannot contaminate a new envelope', async () => {
      assert.equal(canonicalize({ z: 1, a: ['中文', true] }), '{"a":["中文",true],"z":1}');
      for (const value of [NaN, -0, 1.5, undefined, '\uD800', [, 1]]) assert.throws(() => canonicalize(value));
      const input = { streamId: A, sequence: '1', previousHash: '0x' + '0'.repeat(64), kind: 'submission', payload: payload('id') };
      assert.deepEqual(makeSourceEnvelope({ ...input, hash: 'old' }), makeSourceEnvelope(input));
    });
    await scenario('slow disk sync yields to existing host interactions and concurrent admissions keep contiguous order', async () => {
      let release, entered;
      const gate = new Promise(yes => { release = yes; });
      const syncing = new Promise(yes => { entered = yes; });
      const journal = new ActivityJournal(fixture, { guildId: G, scope: 'test', fs: { syncAsync: async fd => { entered(); await gate; fsyncSync(fd); } } });
      const first = journal.admit(payload('concurrent-first')), second = journal.admit(payload('concurrent-second'));
      await syncing;
      let hostHandled = false; await new Promise(yes => setTimeout(() => { hostHandled = true; yes(); }, 1));
      assert.equal(hostHandled, true); assert.equal(journal.receipts.size, 0); assert.equal(journal.pendingWrites, 2);
      release(); const rows = await Promise.all([first, second]); assert.equal(rows[0].receipt.envelope.sequence, '1'); assert.equal(rows[1].receipt.envelope.sequence, '2');
      assert.equal(rows[1].receipt.envelope.previousHash, rows[0].receipt.envelope.hash); await journal.close();
    });
    await scenario('cutoff challenge fences new A handlers, waits earlier admission, persists closure across restart, and allows B', async () => {
      const h = harness(); let mod = h.module(); await mod.start(); const thread = await h.open(mod);
      let entered, release, seen;
      const isHandling = new Promise(yes => { entered = yes; }), wait = new Promise(yes => { release = yes; }), challenged = new Promise(yes => { seen = yes; });
      const before = h.interaction('submit', { text: 'A was already being handled' }); before.channelId = thread.id;
      before.deferReply = async () => { entered(); await wait; };
      const handling = mod.handleInteraction(before); await isHandling;
      h.state.onChallenge = seen; const flushing = mod.flush(); await challenged; await new Promise(yes => setImmediate(yes));
      const after = h.interaction('submit', { text: 'A must be closed' }); after.channelId = thread.id; await mod.handleInteraction(after); assert.match(after.replies.at(-1).content, /已截止/);
      release(); await handling; await flushing;
      assert.equal(mod.state().pending, 1); assert.equal(h.state.coverage.at(-1).capture.admissionClosures[0].closedSequence, '1'); assert.equal(h.state.coverage.at(-1).capture.pendingBeforeCutoff, 1);
      await mod.flush(); assert.equal(mod.state().pending, 0); await mod.stop(); h.advance(91_000);
      const journal = new ActivityJournal(fixture, { guildId: G, scope: 'test' });
      await assert.rejects(journal.admit(payload('new-A')), error => error.code === 'ACTIVITY_ADMISSION_CLOSED');
      const otherActivity = '66666666-6666-4666-8666-666666666666'; await journal.admit({ ...payload('new-B'), activity_id: otherActivity }); await journal.close();
      mod = h.module(); await mod.start(); h.state.failDelivery = true; await mod.flush();
      assert.equal(mod.state().pending, 1); const coverage = h.state.coverage.at(-1);
      assert.equal(coverage.capture.admissionClosures[0].closedSequence, '1'); assert.equal(coverage.capture.localSequence, '2'); assert.equal(coverage.throughSequence, '1'); assert.equal(coverage.capture.pendingBeforeCutoff, 0);
      const announcement = h.state.requests.filter(row => row.path === '/source/lease').at(-1).body;
      assert.equal(announcement.pendingComplete, true); assert.equal(announcement.pending[0].activityId, otherActivity); assert.equal(announcement.pending[0].sequence, '2');
      await mod.stop();
    });
    await scenario('durable queue checks closure at actual commit rather than a stale handler check', async () => {
      const journal = new ActivityJournal(fixture, { guildId: G, scope: 'test' });
      const close = journal.closeActivity({ activityId: A, id: RES, scopeHash: '0x' + '1'.repeat(64), generation: '1', cutoff: '2026-11-18T12:00:00.000Z' });
      const tooLate = journal.admit(payload('queued-after-close'));
      await close; await assert.rejects(tooLate, error => error.code === 'ACTIVITY_ADMISSION_CLOSED'); assert.equal(journal.head.sequence, '0');
      const b = await journal.admit({ ...payload('B-after-close'), activity_id: T }); assert.equal(b.receipt.envelope.sequence, '1'); await journal.close();
    });
    await scenario('private receipt/result notifications and archive retry without replaying accepted submissions', async () => {
      const h = harness(), mod = h.module(); await mod.start(); const thread = await h.open(mod);
      const i = h.interaction('submit', { text: 'Notify retry fixture', notificationFails: true }); i.channelId = thread.id; await mod.handleInteraction(i);
      h.state.status = 'completed'; h.state.failNotification = true; await mod.flush(); assert.equal(mod.state().pending, 0); assert.equal(h.state.deliveries.length, 1); assert.notEqual(h.state.archived, true);
      h.state.failNotification = false; h.state.failArchive = true; await mod.flush(); assert.equal(thread.archived, true); const sent = thread.sent.length;
      h.state.failArchive = false; await mod.flush(); assert.equal(h.state.archived, true); assert.equal(thread.sent.length, sent); assert.equal(h.state.deliveries.length, 1); await mod.stop();
    });
    await scenario('all activity HTTP paths share bounded API backpressure rather than exceeding backend budget', async () => {
      const h = harness(), api = new ActivityApi({ scope: 'test', apiOrigin: env.ACTIVITY_API_ORIGIN, apiToken: env.ACTIVITY_API_TOKEN }, h.fetchImpl, h.now);
      for (let n = 0; n < 259; n++) await api.heartbeat(); // one health + 259 heartbeats
      await assert.rejects(api.heartbeat(), error => error.code === 'ACTIVITY_API_BACKPRESSURE'); assert.equal(h.state.requests.length, 260);
      h.advance(60_001); await api.heartbeat(); assert.equal(h.state.requests.length, 262);
    });
    await scenario('HTTP is restricted to loopback or explicit Railway private DNS; arbitrary public HTTP is rejected', async () => {
      for (const origin of ['http://127.0.0.1:8789', 'http://activity-api.railway.internal:8789', 'https://activity.example.com']) assert.ok(!activityConfig({ ...env, ACTIVITY_API_ORIGIN: origin }, fixture).errors.includes('ACTIVITY_API_ORIGIN'));
      for (const origin of ['http://example.com:8789', 'http://activity-api.railway.internal.evil.example', 'http://evilrailway.internal', 'http://user:pass@activity-api.railway.internal:8789']) assert.ok(activityConfig({ ...env, ACTIVITY_API_ORIGIN: origin }, fixture).errors.includes('ACTIVITY_API_ORIGIN'));
    });
    await scenario('independent system TS/Python Unicode vectors match this JS adapter exactly', async () => {
      const v = JSON.parse(readFileSync(new URL('./protocol.vectors.json', import.meta.url), 'utf8'));
      assert.equal(sourceGenesis(v.genesis.input.streamId, v.genesis.input.guildId, v.genesis.input.scope), v.genesis.hash);
      assert.equal(canonicalize(v.envelope.input), v.envelope.canonical); assert.equal(makeSourceEnvelope(v.envelope.input).hash, v.envelope.hash);
      assert.equal(submissionFingerprint(v.semanticFingerprint.input), v.semanticFingerprint.hash); assert.equal(submissionFingerprint(v.semanticFingerprint.equivalentUrlInput), v.semanticFingerprint.hash);
      assert.notEqual(submissionFingerprint({ ...v.semanticFingerprint.input, content: 'Changed' }), v.semanticFingerprint.hash);
    });
    await scenario('real API pending_review/completed status names notify accurately and archive only on completion', async () => {
      const h = harness(), mod = h.module(); await mod.start(); const thread = await h.open(mod);
      const i = h.interaction('submit', { text: 'Review status fixture' }); i.channelId = thread.id; await mod.handleInteraction(i);
      h.state.status = 'pending_review'; await mod.flush(); assert.equal(thread.archived, false); assert.match(thread.sent.at(-1).content, /等待管理員審核，尚未發放GP/);
      h.state.status = 'completed'; await mod.flush(); assert.equal(thread.archived, true); assert.match(thread.sent.at(-1).content, /已完成，GP與貢獻紀錄已同步/);
      const count = thread.sent.length; await mod.flush(); assert.equal(thread.sent.length, count); assert.equal(h.state.deliveries.length, 1); await mod.stop();
    });
    await scenario('maintenance stops new admission but flushes old durable receipts, keeps status readable and resumes after sync', async () => {
      const h = harness(); h.state.noChallenges = true; const mod = h.module(); await mod.start(); const thread = await h.open(mod);
      const saved = h.interaction('submit', { text: 'Already fsynced before maintenance' }); saved.channelId = thread.id; await mod.handleInteraction(saved); assert.equal(mod.state().pending, 1);
      h.state.maintenance = true; await mod.flush(); assert.equal(mod.state().pending, 0); assert.equal(h.state.receipts.size, 1); assert.equal(mod.state().available, false);
      const next = h.interaction('submit', { text: 'Must not be durably admitted' }); next.channelId = thread.id; await mod.handleInteraction(next); assert.match(next.replies.at(-1).content, /維護/); assert.equal(h.state.receipts.size, 1);
      const modal = h.interaction('submit'); modal.channelId = thread.id; await mod.handleInteraction(modal); assert.ok(!modal.replies.some(row => row.modal)); assert.match(modal.replies.at(-1).content, /維護/);
      const status = h.interaction('status', { receipt: saved.id }); await mod.handleInteraction(status); assert.match(status.replies.at(-1).content, new RegExp(saved.id));
      h.state.maintenance = false; await mod.flush(); assert.equal(mod.state().available, true);
      const resumed = h.interaction('submit', { text: 'New work after confirmed resumption' }); resumed.channelId = thread.id; await mod.handleInteraction(resumed); assert.equal(mod.state().pending, 1); await mod.stop();
    });
    await scenario('failed admission-state sync never gains time from unrelated lease renewal; missing explicit flag fails closed', async () => {
      const h = harness(); h.state.noChallenges = true; const mod = h.module(); await mod.start(); const until = mod.state().admissionConfirmedUntil;
      h.state.admissionStateOffline = true; h.advance(61_000); await mod.flush(); assert.equal(mod.state().admissionConfirmedUntil, until); assert.equal(mod.state().available, true);
      h.advance(30_001); await mod.flush(); assert.equal(mod.state().available, false); assert.equal(mod.state().admissionConfirmedUntil, until);
      h.state.admissionStateOffline = false; h.state.invalidAdmissionState = true; await mod.flush(); assert.equal(mod.state().available, false);
      h.state.invalidAdmissionState = false; await mod.flush(); assert.equal(mod.state().available, true); await mod.stop();
    });
    await scenario('maintenance recheck occurs in the journal queue, while an in-flight successful fsync remains accepted', async () => {
      const h = harness(); h.state.noChallenges = true; let block = false, entered, release;
      const syncing = new Promise(yes => { entered = yes; }), gate = new Promise(yes => { release = yes; });
      const journal = new ActivityJournal(fixture, { guildId: G, scope: 'test', fs: { syncAsync: async fd => { if (block) { entered(); await gate; } fsyncSync(fd); } } });
      const api = new ActivityApi({ scope: 'test', apiOrigin: env.ACTIVITY_API_ORIGIN, apiToken: env.ACTIVITY_API_TOKEN }, h.fetchImpl, h.now), worker = new ActivityWorker({ journal, api, client: h.client, now: h.now, logger: quiet });
      await worker.start(); block = true;
      const first = journal.admit(payload('maintenance-in-flight'), () => worker.canAdmit()); await syncing;
      h.state.maintenance = true; await worker.syncAdmissionState();
      const second = journal.admit(payload('maintenance-after-pause'), () => worker.canAdmit()); release();
      await first; await assert.rejects(second, error => error.code === 'ACTIVITY_SOURCE_NOT_READY'); assert.equal(journal.receipts.size, 1);
      await worker.flush(); assert.equal(journal.sourcePending().length, 0); assert.equal(h.state.receipts.size, 1); await worker.stop(); await journal.close();
    });
    await scenario('permanent source rejection without event ID notifies once and stays acknowledged across restart', async () => {
      const h = harness(); h.state.noChallenges = true; let mod = h.module(); await mod.start(); const thread = await h.open(mod);
      const i = h.interaction('submit', { text: 'reject fixture' }); i.channelId = thread.id; await mod.handleInteraction(i); await mod.flush();
      assert.equal(h.state.receipts.get('1').result.eventId, undefined); assert.equal(mod.state().pending, 0);
      assert.ok(thread.sent.some(row => /來源驗證未通過/.test(row.content) && /INVALID_SUBMISSION/.test(row.content)));
      const sent = thread.sent.length, delivered = h.state.deliveries.length; await mod.flush(); assert.equal(thread.sent.length, sent); assert.equal(h.state.deliveries.length, delivered);
      assert.equal(h.state.deliveries[0].envelopes[0].payload.content, 'reject fixture'); await mod.stop(); h.advance(91_000);
      mod = h.module(); await mod.start(); await mod.flush(); assert.equal(mod.state().pending, 0); assert.equal(thread.sent.length, sent); assert.equal(h.state.deliveries.length, delivered); await mod.stop();
    });
  } finally { if (existsSync(fixture)) unlinkSync(fixture); rmdirSync(fixtureDir); }
});
