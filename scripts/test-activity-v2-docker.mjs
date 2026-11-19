// Local image verification only. No Bot login, host mounts, volumes or cloud calls.
// The caller chooses the run deadline; child processes are asynchronous and emit
// a fixed progress frame every five seconds, never raw build/test diagnostics.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const imageName = 'top-market-bot-wallet-v2:20261119-local';
const names = {
  tests: 'top-market-bot-wallet-v2-tests-20261119',
  prestart: 'top-market-bot-wallet-v2-prestart-20261119',
};
const testFiles = ['activity/policy.test.mjs', 'scripts/activity-volume.test.mjs', 'discord-lifecycle.test.mjs', 'activity/integration.test.mjs'];
const credentials = ['DISCORD_TOKEN', 'DISCORD_CLIENT_ID', 'DATABASE_URL', 'ALCHEMY_API_KEY'];
const runId = randomUUID(), attempted = [], results = [], cleanup = [];
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
const fail = code => { throw Object.assign(Error(code), { code }); };
let source, labels, activeChild, builtImageId = null, interrupted = false, cleaning = false, failure = null;
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  interrupted = true;
  if (!cleaning) activeChild?.kill('SIGTERM');
});

async function command(executable, args, phase) {
  if (interrupted && !cleaning) fail('V2_RUN_INTERRUPTED');
  const started = Date.now(); emit({ event: 'start', phase });
  return new Promise((yes, no) => {
    let stdout = '', stderr = '', settled = false;
    const child = spawn(executable, args, { cwd: repo, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    activeChild = child;
    // Keep bounded tails internally. Never print Docker stderr, command arguments,
    // environment values, TAP payloads, auth configuration or exception stacks.
    child.stdout.on('data', bytes => { stdout = (stdout + bytes.toString('utf8')).slice(-2_000_000); });
    child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString('utf8')).slice(-2_000_000); });
    const progress = setInterval(() => emit({ event: 'progress', phase, elapsedMs: Date.now() - started }), 5000);
    progress.unref();
    const finish = () => { clearInterval(progress); if (activeChild === child) activeChild = undefined; };
    child.once('error', () => { if (!settled) { settled = true; finish(); no(Object.assign(Error('V2_COMMAND_START_FAILED'), { code: 'V2_COMMAND_START_FAILED' })); } });
    child.once('close', (exitCode, signal) => {
      if (settled) return;
      settled = true; finish();
      emit({ event: 'finish', phase, elapsedMs: Date.now() - started, exitCode, signalled: signal !== null });
      yes({ stdout, stderr, exitCode });
    });
  });
}
async function checked(executable, args, phase) {
  const result = await command(executable, args, phase);
  if (result.exitCode !== 0) fail('V2_COMMAND_FAILED');
  return result;
}
async function metadata() {
  const head = (await checked('git', ['rev-parse', 'HEAD'], 'source-head')).stdout.trim();
  const dirty = (await checked('git', ['status', '--porcelain'], 'source-dirty')).stdout;
  if (!/^[0-9a-f]{40}$/.test(head)) fail('V2_SOURCE_METADATA_INVALID');
  return { head, dirty, sourceDirty: dirty.trim().length > 0 };
}
async function inspect(kind, name) {
  const result = await command('docker', [kind, 'inspect', name], 'inspect-' + kind);
  if (result.exitCode !== 0) {
    if (/No such (?:image|container|object)/i.test(result.stderr)) return null;
    fail('V2_RESOURCE_INSPECT_FAILED');
  }
  try {
    const values = JSON.parse(result.stdout);
    if (!Array.isArray(values) || values.length !== 1 || typeof values[0]?.Id !== 'string') fail('V2_RESOURCE_INSPECT_INVALID');
    return values[0];
  } catch { fail('V2_RESOURCE_INSPECT_INVALID'); }
}
function verifyOwner(resource, actual) {
  const actualLabels = actual?.Config?.Labels;
  if (!actual || !Object.entries(labels).every(([key, value]) => actualLabels?.[key] === value)) fail('V2_RESOURCE_OWNER_MISMATCH');
  if (resource.id && actual.Id !== resource.id) fail('V2_RESOURCE_ID_CHANGED');
  if (!/^(?:sha256:)?[0-9a-f]{64}$/.test(actual.Id)) fail('V2_RESOURCE_ID_INVALID');
}
async function owned(resource) {
  const actual = await inspect(resource.kind, resource.name);
  verifyOwner(resource, actual);
  return actual;
}
async function remember(resource) {
  const actual = await owned(resource); resource.id = actual.Id;
  return actual;
}
function labelArgs() { return Object.entries(labels).flatMap(([key, value]) => ['--label', `${key}=${value}`]); }

const identityPrelude = `
  import { readFileSync } from 'node:fs';
  const fail = () => { throw Error('V2_RUNTIME_IDENTITY_OR_ENV_INVALID'); };
  if (process.platform !== 'linux' || process.versions.node.split('.')[0] !== '22'
    || process.getuid() !== 1000 || process.geteuid() !== 1000 || process.getgid() !== 1000 || process.getegid() !== 1000
    || process.getgroups().some(group => group !== 1000)) fail();
  const status = readFileSync('/proc/self/status', 'utf8');
  const cap = /^CapEff:\\s*([0-9a-f]+)$/mi.exec(status)?.[1];
  if (!cap || BigInt('0x' + cap) !== 0n || !/^NoNewPrivs:\\s*1$/m.test(status)) fail();
  if (${JSON.stringify(credentials)}.some(key => process.env[key] !== '')) fail();
  console.log('V2_RUNTIME ' + JSON.stringify({ node: process.version, uid: process.getuid(), gid: process.getgid(), noNewPrivileges: true, effectiveCapabilities: '0' }));
`;
async function createContainer(name, image, nodeArgs) {
  const resource = { kind: 'container', name }; attempted.push(resource);
  await checked('docker', ['container', 'create', '--name', name, ...labelArgs(), '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    ...credentials.flatMap(key => ['--env', `${key}=`]), '--env', 'TEST_DATABASE_URL=', '--entrypoint', 'node', image.id, ...nodeArgs], 'create-container');
  const actual = await remember(resource);
  if (actual.Config.User !== 'node' || actual.Config.Entrypoint?.join(' ') !== 'node' || actual.Image !== image.id || actual.HostConfig.NetworkMode !== 'none'
    || !(actual.HostConfig.CapDrop ?? []).includes('ALL') || !(actual.HostConfig.SecurityOpt ?? []).some(value => value === 'no-new-privileges' || value === 'no-new-privileges=true')
    || (actual.Mounts ?? []).length !== 0 || (actual.HostConfig.Binds ?? []).length !== 0 || (actual.HostConfig.Mounts ?? []).length !== 0) fail('V2_CONTAINER_ISOLATION_INVALID');
  return resource;
}
function runtimeSummary(stdout) {
  const frames = stdout.split(/\r?\n/).map(line => line.replace(/^# /, '')).filter(line => line.startsWith('V2_RUNTIME ')).map(line => {
    try { return JSON.parse(line.slice('V2_RUNTIME '.length)); } catch { fail('V2_RUNTIME_MARKER_INVALID'); }
  });
  if (!frames.length || frames.some(frame => frame.uid !== 1000 || frame.gid !== 1000 || frame.noNewPrivileges !== true || frame.effectiveCapabilities !== '0' || !/^v22\.\d+\.\d+$/.test(frame.node))) fail('V2_RUNTIME_MARKER_MISSING');
  return { node: frames[0].node, uid: 1000, gid: 1000, observations: frames.length, noNewPrivileges: true, effectiveCapabilities: '0' };
}
async function runContainer(resource, phase) {
  const result = await command('docker', ['container', 'start', '--attach', resource.id], phase);
  const actual = await owned(resource);
  if (actual.State.Running) fail('V2_CONTAINER_TEST_STILL_RUNNING');
  return { ...result, containerExitCode: actual.State.ExitCode };
}
function testSummary(stdout) {
  const count = field => { const matches = [...stdout.matchAll(new RegExp('^# ' + field + ' (\\d+)$', 'gm'))]; if (!matches.length) fail('V2_TAP_SUMMARY_MISSING'); return Number(matches.at(-1)[1]); };
  const summary = Object.fromEntries(['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'].map(field => [field, count(field)]));
  return summary;
}

try {
  if (process.argv.length !== 2) fail('V2_ARGUMENTS_NOT_SUPPORTED');
  source = await metadata();
  labels = { 'io.top-market.test': 'bot-wallet-v2', 'io.top-market.session': '20261119-local', 'io.top-market.run': runId,
    'org.opencontainers.image.revision': source.head, 'io.top-market.source-dirty': String(source.sourceDirty) };
  emit({ event: 'source', head: source.head, sourceDirty: source.sourceDirty });
  await checked('docker', ['version', '--format', '{{.Server.Version}}'], 'docker-engine');
  for (const resource of [{ kind: 'image', name: imageName }, ...Object.values(names).map(name => ({ kind: 'container', name }))]) {
    if (await inspect(resource.kind, resource.name)) fail('V2_PREEXISTING_RESOURCE_REFUSED');
  }
  const image = { kind: 'image', name: imageName }; attempted.push(image);
  await checked('docker', ['build', '--file', resolve(repo, 'Dockerfile'), ...labelArgs(), '--tag', imageName, repo], 'build-image');
  const actualImage = await remember(image);
  builtImageId = image.id;
  if (actualImage.Config.User !== 'node' || Object.keys(actualImage.Config.Volumes ?? {}).length) fail('V2_IMAGE_USER_OR_VOLUME_INVALID');
  const afterBuild = await metadata();
  if (afterBuild.head !== source.head || afterBuild.dirty !== source.dirty) fail('V2_SOURCE_CHANGED_DURING_BUILD');
  emit({ event: 'image', head: source.head, sourceDirty: source.sourceDirty, imageId: image.id, defaultUser: 'node' });

  const tests = await createContainer(names.tests, image, ['--import', 'data:text/javascript,' + encodeURIComponent(identityPrelude), '--test', ...testFiles]);
  const testsResult = await runContainer(tests, 'linux-node-tests');
  const summary = testSummary(testsResult.stdout);
  results.push({ name: 'linux-node-tests', ...summary, exitCode: testsResult.containerExitCode, runtime: runtimeSummary(testsResult.stdout) });
  if (testsResult.exitCode !== 0 || testsResult.containerExitCode !== 0 || summary.tests !== 53 || summary.pass !== 53 || summary.fail || summary.cancelled || summary.skipped || summary.todo) fail('V2_TAP_EXPECTATION_FAILED');
  const prestart = await createContainer(names.prestart, image, ['--input-type=module', '-e', identityPrelude + "\nawait import('./scripts/verify-cat-assets.mjs');\nawait import('./scripts/verify-poster-browser.mjs');"]);
  const prestartResult = await runContainer(prestart, 'original-prestart');
  const assets = /已驗證 (\d+) 個等待動畫及來源資料/.exec(prestartResult.stdout);
  if (prestartResult.exitCode !== 0 || prestartResult.containerExitCode !== 0 || !assets || !prestartResult.stdout.includes('Gavin poster browser ready')) fail('V2_PRESTART_MARKER_MISSING');
  results.push({ name: 'original-prestart', verifiedAssets: Number(assets[1]), posterBrowserReady: true, runtime: runtimeSummary(prestartResult.stdout) });
} catch (error) { failure = typeof error?.code === 'string' && /^V2_[A-Z_]+$/.test(error.code) ? error.code : 'V2_VERIFICATION_FAILED'; }
finally {
  cleaning = true;
  // Include partial create/build outcomes, but only this run's unique labels can
  // establish ownership. Re-inspect the captured ID immediately before removal.
  for (const resource of [...attempted].reverse()) {
    try {
      const existing = await inspect(resource.kind, resource.name);
      if (!existing) { cleanup.push({ name: resource.name, absent: true }); continue; }
      verifyOwner(resource, existing); resource.id ??= existing.Id;
      const actual = await owned(resource);
      if (resource.kind === 'container') {
        if (actual.State.Running) await checked('docker', ['container', 'stop', '--time', '10', resource.id], 'cleanup-stop');
        await owned(resource);
        await checked('docker', ['container', 'rm', resource.id], 'cleanup-container');
      } else await checked('docker', ['image', 'rm', resource.name], 'cleanup-image');
      if (await inspect(resource.kind, resource.name)) fail('V2_CLEANUP_INCOMPLETE');
      cleanup.push({ name: resource.name, removed: true });
    } catch { failure ??= 'V2_CLEANUP_FAILED'; cleanup.push({ name: resource.name, removed: false, code: 'V2_CLEANUP_FAILED' }); }
  }
}
emit({ event: 'result', head: source?.head ?? null, sourceDirty: source?.sourceDirty ?? null, imageId: builtImageId, resourcesAttempted: attempted.length, results, cleanup, success: !failure && !interrupted, ...(failure ? { code: failure } : interrupted ? { code: 'V2_RUN_INTERRUPTED' } : {}) });
if (failure || interrupted) process.exitCode = 1;
