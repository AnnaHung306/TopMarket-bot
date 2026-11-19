// Local Docker fixture only. It has no tokens, network, PostgreSQL or Bot login.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import fsMutable from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import { bootstrapActivityVolume, ActivityIdentityError } from './activity-volume.mjs';
import { runContainerStartup } from './container-start.mjs';
import { ActivityJournal } from '../activity/journal.mjs';
import { createActivityModule } from '../activity/index.mjs';
import { activityStartupContext } from '../activity/startup-context.mjs';
import { createWalletWorkDrain, createBotShutdown } from '../discord-lifecycle.mjs';

const scenario = process.argv[2], root = '/data/activity';
const digest = path => createHash('sha256').update(fs.readFileSync(path)).digest('hex');
const output = value => console.log('VOLUME_FIXTURE ' + JSON.stringify(value));
function ownedScope(scope, uid = 1000, gid = 1000, mode = 0o700) { const path = `${root}/${scope}`; fs.mkdirSync(path, { mode }); fs.chownSync(path, uid, gid); return path; }
function refuse(expected, check = () => {}) {
  assert.throws(() => bootstrapActivityVolume(), error => error.code === expected); check(); output({ scenario, refused: expected });
}
function identity() {
  assert.equal(process.getuid(), 1000); assert.equal(process.getgid(), 1000); assert.ok(process.getgroups().every(group => group === 1000));
  assert.throws(() => process.setuid(0), error => error.code === 'EPERM');
}

if (['initialize', 'restart', 'production', 'nonroot'].includes(scenario)) {
  const state = bootstrapActivityVolume(); identity(); const before = digest(state.journalPath);
  const journal = new ActivityJournal(state.journalPath, { guildId: '12345678901234567', scope: state.scope });
  if (scenario === 'initialize' || scenario === 'production') {
    assert.equal(journal.head.sequence, '0');
    await journal.register('2026-11-18T00:00:00.000Z');
    await journal.admit({ source_event_id: 'TEST_ONLY_DURABLE_INTERACTION', discord_user_id: '22345678901234567', activity_id: '11111111-1111-4111-8111-111111111111', task_id: '22222222-2222-4222-8222-222222222222', guild_id: '12345678901234567', channel_id: '32345678901234567', event_at: '2026-11-18T00:00:01.000Z', content: 'TEST ONLY persistent admission', evidence: [] });
  } else { assert.equal(journal.head.sequence, '1'); assert.equal(journal.receipts.size, 1); }
  const streamId = journal.stream.streamId, head = journal.head; await journal.close();
  if (scenario === 'restart' || scenario === 'nonroot') assert.equal(digest(state.journalPath), before, 'bootstrap/readback never changes an existing journal');
  assert.deepEqual(fs.readdirSync(state.directory), ['journal.ndjson']);
  const meta = fs.lstatSync(state.journalPath); assert.equal(meta.uid, 1000); assert.equal(meta.gid, 1000); assert.equal(meta.mode & 0o7777, 0o600);
  output({ scenario, uid: process.getuid(), gid: process.getgid(), scope: state.scope, streamId, head, digest: digest(state.journalPath) });
} else if (scenario === 'reject-scope-link') {
  fs.symlinkSync('/tmp', `${root}/test`); refuse('ACTIVITY_VOLUME_PATH_UNSAFE', () => assert.equal(fs.readlinkSync(`${root}/test`), '/tmp'));
} else if (scenario === 'reject-file-link') {
  const path = ownedScope('production'); fs.symlinkSync('/tmp', path + '/journal.ndjson'); refuse('ACTIVITY_VOLUME_JOURNAL_UNSAFE', () => assert.equal(fs.readlinkSync(path + '/journal.ndjson'), '/tmp'));
} else if (scenario === 'reject-owner' || scenario === 'reject-root-owner') {
  const scope = scenario === 'reject-owner' ? 'test' : 'production', owner = scenario === 'reject-owner' ? 2000 : 0, path = ownedScope(scope, owner, owner), before = fs.lstatSync(path);
  refuse('ACTIVITY_VOLUME_SCOPE_OWNER_INVALID', () => { const after = fs.lstatSync(path); assert.equal(after.uid, before.uid); assert.equal(after.gid, before.gid); assert.equal(after.mode, before.mode); });
} else if (scenario === 'reject-journal-owner') {
  const path = ownedScope('test') + '/journal.ndjson'; fs.writeFileSync(path, 'TEST ONLY root-owned data\n', { mode: 0o600 }); const before = digest(path);
  refuse('ACTIVITY_VOLUME_JOURNAL_OWNER_MODE_INVALID', () => { assert.equal(fs.lstatSync(path).uid, 0); assert.equal(digest(path), before); });
} else if (scenario === 'reject-mode') {
  const path = ownedScope('production', 1000, 1000, 0o755); refuse('ACTIVITY_VOLUME_SCOPE_MODE_INVALID', () => assert.equal(fs.lstatSync(path).mode & 0o7777, 0o755));
} else if (scenario === 'readonly') {
  const path = `${root}/test/journal.ndjson`, before = digest(path); refuse('ACTIVITY_VOLUME_READ_ONLY', () => assert.equal(digest(path), before));
} else if (scenario === 'missing-mount') refuse('ACTIVITY_VOLUME_NOT_MOUNTED');
else if (scenario === 'outside-path') refuse('ACTIVITY_VOLUME_JOURNAL_PATH_INVALID', () => assert.equal(fs.existsSync('/tmp/top-market-bootstrap-outside.ndjson'), false));
else if (scenario === 'prestart') {
  const state = await runContainerStartup({ loadBot: async () => { identity(); output({ scenario, prestart: 'original_checks_passed', uid: process.getuid(), pid: process.pid }); } }); assert.equal(state.scope, 'test');
} else if (scenario === 'host-storage-blocked') {
  const path = `${root}/test/journal.ndjson`, before = digest(path), metadata = fs.lstatSync(path);
  let loaded = false;
  const state = await runContainerStartup({ loadBot: async () => {
    loaded = true; identity(); assert.equal(process.env.ACTIVITY_ENABLED, 'true');
    const context = activityStartupContext(); assert.ok(Object.isFrozen(context)); assert.equal(context.activityUnavailable, 'ACTIVITY_VOLUME_READ_ONLY');
    let journalAccesses = 0, apiCalls = 0, walletCalls = 0;
    const originals = Object.fromEntries(['mkdirSync', 'existsSync', 'readFileSync', 'openSync'].map(name => [name, fsMutable[name]]));
    for (const name of Object.keys(originals)) fsMutable[name] = (target, ...args) => {
      if (target === path || target === `${root}/test`) { journalAccesses++; throw Error('TEST_ONLY_FORBIDDEN_JOURNAL_ACCESS'); }
      return originals[name](target, ...args);
    };
    syncBuiltinESMExports();
    try {
      const activity = createActivityModule({ client: { channels: { fetch: async () => { apiCalls++; throw Error(); } } }, env: process.env,
        fetchImpl: async () => { apiCalls++; throw Error(); }, activityUnavailable: context.activityUnavailable });
      await assert.rejects(activity.start(), error => error.code === context.activityUnavailable);
      await assert.rejects(activity.start(), error => error.code === context.activityUnavailable);
      const replies = [];
      await activity.handleInteraction({ isChatInputCommand: () => true, commandName: 'activity', reply: async value => replies.push(value) });
      assert.match(replies[0].content, /尚未受理/); assert.match(replies[0].content, /ACTIVITY_VOLUME_READ_ONLY/);
      assert.equal(activity.state().error, context.activityUnavailable); assert.equal(activity.state().accepting, false);
      await activity.flush(); await activity.stop(); assert.equal(journalAccesses, 0); assert.equal(apiCalls, 0);
      const wallet = createWalletWorkDrain({ handler: async () => { walletCalls++; }, logger: { info() {}, warn() {}, error() {} } });
      await wallet.handleInteraction({ isChatInputCommand: () => true, commandName: 'wallet' });
      assert.equal(walletCalls, 1); wallet.stopAccepting(); await wallet.drain();
    } finally { Object.assign(fsMutable, originals); syncBuiltinESMExports(); }
  } });
  assert.equal(loaded, true); assert.equal(state.activityUnavailable, 'ACTIVITY_VOLUME_READ_ONLY');
  assert.equal(digest(path), before); const after = fs.lstatSync(path);
  for (const key of ['ino', 'uid', 'gid', 'mode', 'size', 'mtimeMs', 'ctimeMs']) assert.equal(after[key], metadata[key]);
  output({ scenario, uid: process.getuid(), prestart: 'original_checks_passed', walletLoaded: true, activityBlocked: state.activityUnavailable, journalUnchanged: true });
} else if (scenario === 'host-identity-fatal') {
  let loaded = false;
  await assert.rejects(runContainerStartup({ loadBot: async () => { loaded = true; } }), error => error instanceof ActivityIdentityError && error.code === 'ACTIVITY_RUNTIME_IDENTITY_INVALID');
  assert.equal(loaded, false); assert.equal(activityStartupContext().activityUnavailable, null);
  assert.equal(process.env.ACTIVITY_ENABLED, 'true');
  output({ scenario, refused: 'ACTIVITY_RUNTIME_IDENTITY_INVALID', walletLoaded: false });
} else if (scenario === 'signal') {
  await runContainerStartup({ loadBot: async () => {
    identity(); assert.equal(process.pid, 1); const finish = Promise.withResolvers(), done = Promise.withResolvers();
    const wallet = createWalletWorkDrain({ logger: { info() {}, warn() {}, error() {} }, handler: async () => finish.promise });
    const delivery = wallet.handleInteraction({ isChatInputCommand: () => true, commandName: 'wallet' });
    const shutdown = createBotShutdown({ walletWork: wallet, logger: { info() {}, error() {} }, stopActivity: async () => {}, closeWalletResources: async () => {}, destroyClient: () => done.resolve() });
    const keepalive = setInterval(() => {}, 1000);
    process.once('SIGTERM', () => { const stopping = shutdown(); assert.equal(wallet.state().accepting, false); finish.resolve(); void stopping.then(result => { assert.equal(result.ok, true); }); });
    output({ scenario, ready: true, uid: process.getuid(), pid: process.pid }); await done.promise; await delivery; clearInterval(keepalive); output({ scenario, drained: true, uid: process.getuid(), pid: process.pid });
  } });
} else throw Error('Unknown local volume fixture scenario');
