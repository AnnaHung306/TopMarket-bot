import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, resolve } from 'node:path';
import { activityVolumeSettings, inspectActivityMount } from './activity-volume.mjs';
import { createActivityModule } from '../activity/index.mjs';
import { initializeActivityStartup, activityStartupContext, isActivityStartupBlockCode } from '../activity/startup-context.mjs';

const settings = { ACTIVITY_ENABLED: 'true', ACTIVITY_SCOPE: 'test', ACTIVITY_JOURNAL_PATH: '/data/activity/test/journal.ndjson' };
const mount = '71 23 8:1 /volume /data/activity rw,relatime - ext4 /dev/sda rw\n';
const code = expected => error => error.code === expected;
test('container storage paths are exact, scope-specific and cannot silently fall back', () => {
  assert.equal(activityVolumeSettings(settings).journalPath, settings.ACTIVITY_JOURNAL_PATH);
  assert.equal(activityVolumeSettings({ ...settings, ACTIVITY_SCOPE: 'production', ACTIVITY_JOURNAL_PATH: '/data/activity/production/journal.ndjson' }).scope, 'production');
  for (const value of ['', '.local/journal.ndjson', '/tmp/journal.ndjson', '/data/activity/test/../production/journal.ndjson', '/data/activity/test/journal.ndjson/']) assert.throws(() => activityVolumeSettings({ ...settings, ACTIVITY_JOURNAL_PATH: value }), code('ACTIVITY_VOLUME_JOURNAL_PATH_INVALID'));
  assert.throws(() => activityVolumeSettings({ ...settings, ACTIVITY_SCOPE: 'production' }), code('ACTIVITY_VOLUME_JOURNAL_PATH_INVALID'));
  assert.throws(() => activityVolumeSettings({ ...settings, RAILWAY_VOLUME_MOUNT_PATH: '/elsewhere' }), code('ACTIVITY_VOLUME_MOUNT_PATH_INVALID'));
  assert.deepEqual(activityVolumeSettings({ ACTIVITY_ENABLED: 'false' }), { enabled: false });
});
test('a real mount record is required and volatile, readonly, nested and ambiguous mounts are refused', () => {
  assert.deepEqual(inspectActivityMount(mount), { path: '/data/activity', type: 'ext4' });
  assert.throws(() => inspectActivityMount(''), code('ACTIVITY_VOLUME_NOT_MOUNTED'));
  assert.throws(() => inspectActivityMount(mount.replace('/data/activity', '/data/activity-other')), code('ACTIVITY_VOLUME_NOT_MOUNTED'));
  assert.throws(() => inspectActivityMount(mount.replace('rw,relatime', 'ro,relatime')), code('ACTIVITY_VOLUME_READ_ONLY'));
  for (const type of ['tmpfs', 'overlay', 'ramfs']) assert.throws(() => inspectActivityMount(mount.replace('ext4', type)), code('ACTIVITY_VOLUME_NOT_PERSISTENT'));
  assert.throws(() => inspectActivityMount(mount + mount), code('ACTIVITY_VOLUME_NOT_MOUNTED'));
  assert.throws(() => inspectActivityMount(mount + mount.replace('/data/activity', '/data/activity/test')), code('ACTIVITY_VOLUME_NESTED_MOUNT'));
});
test('native privilege-drop failures remain fatal identity errors with fixed diagnostics', () => {
  const helper = new URL('./activity-volume.mjs', import.meta.url).href;
  const source = `
    import assert from 'node:assert/strict';
    import { ensureNodeIdentity, bootstrapActivityVolume, ActivityIdentityError } from ${JSON.stringify(helper)};
    Object.defineProperty(process, 'platform', { value: 'linux' });
    process.getuid = process.geteuid = () => 0;
    process.setgroups = () => { throw Error('secret-dsn://must-not-escape'); };
    for (const operation of [() => ensureNodeIdentity({ RAILWAY_RUN_UID: '0' }), () => bootstrapActivityVolume({ ACTIVITY_ENABLED: 'false', RAILWAY_RUN_UID: '0' })]) {
      assert.throws(operation, error => error instanceof ActivityIdentityError && error.code === 'ACTIVITY_RUNTIME_PRIVILEGE_DROP_FAILED' && error.message === error.code && !error.stack.includes('secret-dsn'));
    }
    assert.throws(() => ensureNodeIdentity({}), error => error instanceof ActivityIdentityError && error.code === 'ACTIVITY_ROOT_INITIALIZATION_NOT_AUTHORIZED');
    assert.throws(() => bootstrapActivityVolume(null), TypeError, 'unknown programming errors must not become activity storage errors');
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr); assert.doesNotMatch(result.stdout + result.stderr, /secret-dsn/);
  for (const unsafe of ['ACTIVITY_RUNTIME_PRIVILEGE_DROP_FAILED', 'ACTIVITY_ROOT_INITIALIZATION_NOT_AUTHORIZED', 'ACTIVITY_RUNTIME_IDENTITY_INVALID', 'ACTIVITY_VOLUME_LINUX_REQUIRED', 'unknown']) assert.equal(isActivityStartupBlockCode(unsafe), false);
});
test('an invalid activity-only enable setting is an explicit inhibition without changing configuration', () => {
  const env = { ...settings, ACTIVITY_ENABLED: 'TRUE' };
  assert.throws(() => activityVolumeSettings(env), error => error.code === 'ACTIVITY_ENABLED_INVALID' && isActivityStartupBlockCode(error.code));
  assert.equal(env.ACTIVITY_ENABLED, 'TRUE');
});
test('startup inhibition is immutable and single-initialization, never an enable flag', () => {
  assert.deepEqual(activityStartupContext(), { activityUnavailable: null });
  assert.throws(() => initializeActivityStartup({ activityUnavailable: 'secret-dsn://unsafe' }), code('ACTIVITY_STARTUP_CONTEXT_INVALID'));
  const state = initializeActivityStartup({ activityUnavailable: 'ACTIVITY_VOLUME_READ_ONLY' });
  assert.ok(Object.isFrozen(state)); assert.equal(activityStartupContext(), state);
  assert.throws(() => { state.activityUnavailable = null; }, TypeError);
  assert.throws(() => initializeActivityStartup(), code('ACTIVITY_STARTUP_CONTEXT_INVALID'));
});
test('storage-blocked activity refuses before any journal access, API, Discord fetch or recovery timer', async () => {
  const path = resolve('TEST_ONLY_MUST_NEVER_BE_CREATED', 'journal.ndjson'), directory = dirname(path);
  const original = Object.fromEntries(['mkdirSync', 'existsSync', 'readFileSync', 'openSync'].map(name => [name, fs[name]]));
  let accesses = 0, calls = 0, intervals = 0;
  for (const name of Object.keys(original)) fs[name] = (target, ...args) => {
    if (target === path || target === directory) { accesses++; throw Error('TEST_ONLY_FORBIDDEN_JOURNAL_ACCESS'); }
    return original[name](target, ...args);
  };
  const interval = globalThis.setInterval;
  globalThis.setInterval = () => { intervals++; throw Error('TEST_ONLY_FORBIDDEN_TIMER'); };
  syncBuiltinESMExports();
  try {
    const activity = createActivityModule({ client: { channels: { fetch: async () => { calls++; throw Error(); } } }, env: {}, storagePath: path,
      fetchImpl: async () => { calls++; throw Error(); }, activityUnavailable: 'ACTIVITY_VOLUME_READ_ONLY' });
    for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(activity.start(), code('ACTIVITY_VOLUME_READ_ONLY'));
    const replies = [];
    assert.equal(await activity.handleInteraction({ isChatInputCommand: () => true, commandName: 'activity', reply: async value => replies.push(value) }), true);
    assert.match(replies[0].content, /尚未受理/); assert.match(replies[0].content, /ACTIVITY_VOLUME_READ_ONLY/); assert.equal(replies[0].ephemeral, true);
    assert.equal(activity.state().error, 'ACTIVITY_VOLUME_READ_ONLY'); assert.equal(activity.state().accepting, false);
    await activity.flush(); await activity.stop();
    assert.equal(accesses, 0); assert.equal(calls, 0); assert.equal(intervals, 0);
    assert.throws(() => createActivityModule({ client: {}, activityUnavailable: 'secret-dsn://unsafe' }), code('ACTIVITY_STARTUP_CONTEXT_INVALID'));
  } finally {
    Object.assign(fs, original); syncBuiltinESMExports(); globalThis.setInterval = interval;
  }
});
