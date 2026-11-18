import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';

export const ACTIVITY_VOLUME_ROOT = '/data/activity';
const UID = 1000, GID = 1000;
const directoryFlags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
export class ActivityVolumeError extends Error {
  constructor(code) { super(code); this.name = 'ActivityVolumeError'; this.code = code; }
}
const refuse = code => { throw new ActivityVolumeError(code); };
const mode = stat => stat.mode & 0o7777;
function statIfPresent(path) { try { return fs.lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
function assertDirectory(path) {
  const stat = fs.lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) refuse('ACTIVITY_VOLUME_PATH_UNSAFE');
  return stat;
}
function canTraverse(stat) { return Boolean(stat.mode & (stat.uid === UID ? 0o100 : stat.gid === GID ? 0o010 : 0o001)); }
function safeAncestor(path) {
  const stat = assertDirectory(path);
  if (![0, UID].includes(stat.uid) || ![0, GID].includes(stat.gid)) refuse('ACTIVITY_VOLUME_OWNER_UNEXPECTED');
  if (stat.mode & 0o022) refuse('ACTIVITY_VOLUME_MODE_UNSAFE');
  if (!canTraverse(stat)) refuse('ACTIVITY_VOLUME_TRAVERSAL_DENIED');
  return stat;
}
function syncDirectory(path) { const fd = fs.openSync(path, directoryFlags); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function sameFile(a, b) { return a.dev === b.dev && a.ino === b.ino; }

export function activityVolumeSettings(env) {
  if (env.ACTIVITY_ENABLED !== undefined && !['true', 'false', ''].includes(env.ACTIVITY_ENABLED)) refuse('ACTIVITY_ENABLED_INVALID');
  if (env.ACTIVITY_ENABLED !== 'true') return { enabled: false };
  const scope = env.ACTIVITY_SCOPE;
  if (!['test', 'production'].includes(scope)) refuse('ACTIVITY_VOLUME_SCOPE_INVALID');
  const directory = `${ACTIVITY_VOLUME_ROOT}/${scope}`, journalPath = `${directory}/journal.ndjson`;
  if (env.ACTIVITY_JOURNAL_PATH !== journalPath) refuse('ACTIVITY_VOLUME_JOURNAL_PATH_INVALID');
  if (env.RAILWAY_VOLUME_MOUNT_PATH && env.RAILWAY_VOLUME_MOUNT_PATH !== ACTIVITY_VOLUME_ROOT) refuse('ACTIVITY_VOLUME_MOUNT_PATH_INVALID');
  return { enabled: true, scope, directory, journalPath };
}

/** Kernel mount metadata is required; a directory or environment variable alone is not proof of a mount. */
export function inspectActivityMount(text) {
  const decode = value => value.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
  const mounts = text.trim().split('\n').map(line => {
    const split = line.indexOf(' - '); if (split < 0) return null;
    const fields = line.slice(0, split).split(' '), tail = line.slice(split + 3).split(' ');
    return { path: decode(fields[4] || ''), options: (fields[5] || '').split(','), type: tail[0] };
  }).filter(Boolean);
  const matches = mounts.filter(mount => mount.path === ACTIVITY_VOLUME_ROOT);
  if (matches.length !== 1) refuse('ACTIVITY_VOLUME_NOT_MOUNTED');
  const mount = matches[0];
  if (mount.options.includes('ro')) refuse('ACTIVITY_VOLUME_READ_ONLY');
  if (!mount.options.includes('rw') || ['tmpfs', 'ramfs', 'overlay', 'proc', 'sysfs', 'devtmpfs', 'devpts', 'cgroup', 'cgroup2'].includes(mount.type)) refuse('ACTIVITY_VOLUME_NOT_PERSISTENT');
  if (mounts.some(item => item.path.startsWith(ACTIVITY_VOLUME_ROOT + '/'))) refuse('ACTIVITY_VOLUME_NESTED_MOUNT');
  return { path: mount.path, type: mount.type };
}

function assertScope(directory, device) {
  const stat = assertDirectory(directory);
  if (stat.dev !== device || stat.uid !== UID || stat.gid !== GID) refuse('ACTIVITY_VOLUME_SCOPE_OWNER_INVALID');
  if (mode(stat) !== 0o700) refuse('ACTIVITY_VOLUME_SCOPE_MODE_INVALID');
  if (fs.readdirSync(directory).some(name => name !== 'journal.ndjson')) refuse('ACTIVITY_VOLUME_SCOPE_NOT_DEDICATED');
  return stat;
}
function assertJournal(path, device) {
  const stat = statIfPresent(path); if (!stat) return null;
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || stat.dev !== device) refuse('ACTIVITY_VOLUME_JOURNAL_UNSAFE');
  if (stat.uid !== UID || stat.gid !== GID || mode(stat) !== 0o600) refuse('ACTIVITY_VOLUME_JOURNAL_OWNER_MODE_INVALID');
  return stat;
}
function prepareScope(settings, device) {
  let created = false;
  if (!statIfPresent(settings.directory)) { fs.mkdirSync(settings.directory, { mode: 0o700 }); created = true; }
  if (created && process.getuid() === 0) {
    // Only the directory created by this invocation can change ownership. Never recurse.
    const before = fs.lstatSync(settings.directory), fd = fs.openSync(settings.directory, directoryFlags);
    try {
      const opened = fs.fstatSync(fd);
      if (!sameFile(before, opened) || !opened.isDirectory() || opened.uid !== 0 || opened.dev !== device) refuse('ACTIVITY_VOLUME_SCOPE_CHANGED');
      fs.fchownSync(fd, UID, GID); fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    syncDirectory(ACTIVITY_VOLUME_ROOT);
  } else if (created) syncDirectory(ACTIVITY_VOLUME_ROOT);
  assertScope(settings.directory, device); assertJournal(settings.journalPath, device);
}

function dropToNode(env) {
  if (process.getuid() === 0 || process.geteuid() === 0) {
    if (env.RAILWAY_RUN_UID !== '0' || process.getuid() !== 0 || process.geteuid() !== 0) refuse('ACTIVITY_ROOT_INITIALIZATION_NOT_AUTHORIZED');
    process.setgroups([]); process.setgid(GID); process.setuid(UID);
  }
  if (process.getuid() !== UID || process.geteuid() !== UID || process.getgid() !== GID || process.getegid() !== GID || process.getgroups().some(group => group !== GID)) refuse('ACTIVITY_RUNTIME_IDENTITY_INVALID');
  const effectiveCaps = /^CapEff:\s*([0-9a-f]+)$/mi.exec(fs.readFileSync('/proc/self/status', 'utf8'))?.[1];
  if (!effectiveCaps || BigInt('0x' + effectiveCaps) !== 0n) refuse('ACTIVITY_RUNTIME_CAPABILITIES_INVALID');
  const home = assertDirectory('/home/node');
  if (home.uid !== UID || home.gid !== GID) refuse('ACTIVITY_RUNTIME_HOME_INVALID');
  process.env.HOME = '/home/node'; process.env.USER = 'node'; process.env.LOGNAME = 'node';
  process.umask(0o077);
}

function durableProbe(directory) {
  const path = `${directory}/.bootstrap-probe-${process.pid}-${randomUUID()}`, bytes = Buffer.from('activity-volume-check\n');
  let fd, original, failure;
  try {
    fd = fs.openSync(path, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    original = fs.fstatSync(fd); let at = 0;
    while (at < bytes.length) { const count = fs.writeSync(fd, bytes, at, bytes.length - at, at); if (count <= 0) refuse('ACTIVITY_VOLUME_WRITE_FAILED'); at += count; }
    fs.fsyncSync(fd);
    const read = Buffer.alloc(bytes.length); if (fs.readSync(fd, read, 0, read.length, 0) !== bytes.length || !read.equals(bytes)) refuse('ACTIVITY_VOLUME_READBACK_FAILED');
  } catch (error) { failure = error; }
  finally {
    if (fd !== undefined) {
      try {
        const current = fs.lstatSync(path);
        if (!original || !sameFile(original, current) || current.isSymbolicLink()) refuse('ACTIVITY_VOLUME_PROBE_CHANGED');
        fs.closeSync(fd); fd = undefined; fs.unlinkSync(path); syncDirectory(directory);
      } catch (error) { failure ??= error; }
      finally { if (fd !== undefined) fs.closeSync(fd); }
    }
  }
  if (failure) throw failure;
}

/** Linux container startup only. Windows npm startup does not call this helper. */
export function bootstrapActivityVolume(env = process.env) {
  try {
    if (process.platform !== 'linux') refuse('ACTIVITY_VOLUME_LINUX_REQUIRED');
    if (process.getuid() === 0 && env.RAILWAY_RUN_UID !== '0') refuse('ACTIVITY_ROOT_INITIALIZATION_NOT_AUTHORIZED');
    const settings = activityVolumeSettings(env); let mount, device;
    if (settings.enabled) {
      mount = inspectActivityMount(fs.readFileSync('/proc/self/mountinfo', 'utf8'));
      safeAncestor('/data'); device = safeAncestor(ACTIVITY_VOLUME_ROOT).dev;
      prepareScope(settings, device);
    }
    dropToNode(env);
    if (settings.enabled) {
      safeAncestor('/data'); safeAncestor(ACTIVITY_VOLUME_ROOT); assertScope(settings.directory, device);
      durableProbe(settings.directory);
      const before = assertJournal(settings.journalPath, device);
      const flags = fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW | (before ? fs.constants.O_APPEND : fs.constants.O_CREAT | fs.constants.O_EXCL);
      const fd = fs.openSync(settings.journalPath, flags, 0o600);
      try { const opened = fs.fstatSync(fd); if ((before && !sameFile(before, opened)) || opened.dev !== device || opened.uid !== UID || opened.gid !== GID || mode(opened) !== 0o600 || !opened.isFile() || opened.nlink !== 1) refuse('ACTIVITY_VOLUME_JOURNAL_CHANGED'); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      syncDirectory(settings.directory);
    }
    return { ...settings, mount, uid: process.getuid(), gid: process.getgid() };
  } catch (error) { if (error instanceof ActivityVolumeError) throw error; throw new ActivityVolumeError('ACTIVITY_VOLUME_IO_FAILED'); }
}
