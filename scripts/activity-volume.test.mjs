import test from 'node:test';
import assert from 'node:assert/strict';
import { activityVolumeSettings, inspectActivityMount } from './activity-volume.mjs';

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
