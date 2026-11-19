// Explicitly reviewed local resources only; no global Docker pruning or cloud calls.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const image = 'top-market-bot-volume-bootstrap:20261118-local';
const volumes = Object.fromEntries(['ok', 'symlink', 'owner', 'journal'].map(kind => [kind, `top-market-activity-bootstrap-${kind}-20261118`]));
const scenarios = ['initialize', 'restart', 'production', 'nonroot', 'reject-scope-link', 'reject-file-link', 'reject-owner', 'reject-root-owner', 'reject-journal-owner', 'reject-mode', 'readonly', 'missing-mount', 'outside-path', 'prestart', 'signal', 'host-storage-blocked', 'host-identity-fatal'];
const containerName = scenario => `top-market-activity-bootstrap-${scenario}-20261118`;
const labels = { 'io.top-market.test': 'activity-volume-bootstrap', 'io.top-market.session': '20261118-local' };
const labelArgs = Object.entries(labels).flatMap(([key, value]) => ['--label', `${key}=${value}`]);
const created = [], results = [];
function docker(args, { allowFailure = false, inherit = false } = {}) {
  const result = spawnSync('docker', args, { encoding: 'utf8', windowsHide: true, maxBuffer: 20 * 1024 * 1024, timeout: 900_000, stdio: inherit ? 'inherit' : 'pipe' });
  if (result.error || (!allowFailure && result.status !== 0)) throw Error(`Docker ${args[0]} failed: ${result.error?.code || result.stderr || result.status}`);
  return result;
}
function inspect(kind, name) { const result = docker([kind, 'inspect', name], { allowFailure: true }); return result.status === 0 ? JSON.parse(result.stdout)[0] : null; }
function owned(resource) {
  const actual = inspect(resource.kind, resource.name); if (!actual) throw Error('Owned resource disappeared before cleanup: ' + resource.name);
  const actualLabels = resource.kind === 'image' ? actual.Config.Labels : resource.kind === 'container' ? actual.Config.Labels : actual.Labels;
  for (const [key, value] of Object.entries(labels)) assert.equal(actualLabels?.[key], value, resource.name + ' ownership label');
  assert.equal(resource.kind === 'volume' ? actual.Name : actual.Id, resource.id, resource.name + ' identity'); return actual;
}
function remember(kind, name) { const actual = inspect(kind, name); assert.ok(actual); const resource = { kind, name, id: kind === 'volume' ? actual.Name : actual.Id }; created.push(resource); owned(resource); return resource; }
function create(scenario, volume, { scope = 'test', user = '0:0', readonly = false, journalPath } = {}) {
  const name = containerName(scenario), args = ['container', 'create', '--name', name, ...labelArgs, '--network', 'none', '--user', user,
    '--env', 'ACTIVITY_ENABLED=true', '--env', `ACTIVITY_SCOPE=${scope}`, '--env', `ACTIVITY_JOURNAL_PATH=${journalPath || `/data/activity/${scope}/journal.ndjson`}`,
    '--env', 'RAILWAY_VOLUME_MOUNT_PATH=/data/activity', '--env', 'DISCORD_TOKEN=', '--env', 'DISCORD_CLIENT_ID=', '--env', 'DATABASE_URL=', '--env', 'ALCHEMY_API_KEY='];
  if (user === '0:0') args.push('--env', 'RAILWAY_RUN_UID=0');
  if (volume) args.push('--mount', `type=volume,source=${volume},target=/data/activity${readonly ? ',readonly' : ''}`);
  args.push('--entrypoint', 'node', image, 'scripts/activity-volume-fixture.mjs', scenario); docker(args); return remember('container', name);
}
function run(scenario, volume, options) {
  const resource = create(scenario, volume, options), result = docker(['container', 'start', '--attach', resource.name]);
  const actual = owned(resource); assert.equal(actual.State.ExitCode, 0, result.stdout + result.stderr);
  const frames = result.stdout.split(/\r?\n/).filter(line => line.startsWith('VOLUME_FIXTURE ')).map(line => JSON.parse(line.slice(15)));
  assert.equal(frames.length, 1, result.stdout); results.push({ scenario, passed: true }); console.log('PASS ' + scenario); return frames[0];
}
let failure;
try {
  assert.ok(docker(['version', '--format', '{{.Server.Version}}']).stdout.trim());
  for (const [kind, names] of [['image', [image]], ['volume', Object.values(volumes)], ['container', scenarios.map(containerName)]]) for (const name of names) assert.equal(inspect(kind, name), null, 'Refuse pre-existing resource: ' + name);
  docker(['build', ...labelArgs, '--tag', image, '.'], { inherit: true }); const built = remember('image', image); assert.equal(owned(built).Config.User, 'node');
  for (const name of Object.values(volumes)) { docker(['volume', 'create', ...labelArgs, name]); remember('volume', name); }
  const first = run('initialize', volumes.ok), restarted = run('restart', volumes.ok), production = run('production', volumes.ok, { scope: 'production' }), nonroot = run('nonroot', volumes.ok, { user: '1000:1000' });
  assert.equal(first.streamId, restarted.streamId); assert.equal(first.digest, restarted.digest); assert.equal(first.digest, nonroot.digest); assert.notEqual(first.streamId, production.streamId); assert.notEqual(first.head.hash, production.head.hash);
  run('reject-scope-link', volumes.symlink); run('reject-file-link', volumes.symlink, { scope: 'production' });
  run('reject-owner', volumes.owner); run('reject-root-owner', volumes.owner, { scope: 'production' });
  run('reject-journal-owner', volumes.journal); run('reject-mode', volumes.journal, { scope: 'production' });
  run('readonly', volumes.ok, { readonly: true }); run('missing-mount'); run('outside-path', undefined, { journalPath: '/tmp/top-market-bootstrap-outside.ndjson' });
  run('prestart', volumes.ok);
  run('host-storage-blocked', volumes.ok, { readonly: true });
  run('host-identity-fatal', undefined, { user: '2000:2000' });
  const signal = create('signal', volumes.ok); docker(['container', 'start', signal.name]);
  for (let attempt = 0; attempt < 300; attempt++) {
    const logs = docker(['container', 'logs', signal.name]).stdout;
    if (logs.includes('"ready":true')) break;
    if (!owned(signal).State.Running) throw Error('Signal fixture exited before readiness: ' + logs);
    if (attempt === 299) throw Error('Signal fixture readiness timed out');
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  docker(['container', 'stop', '--time', '10', signal.name]); assert.equal(owned(signal).State.ExitCode, 0);
  const logs = docker(['container', 'logs', signal.name]).stdout; assert.ok(logs.includes('"drained":true')); assert.ok(logs.includes('"pid":1'));
  results.push({ scenario: 'signal', passed: true }); console.log('PASS signal');
} catch (error) { failure = error; }
finally {
  // The user was notified of these exact names; validate identity + owner before each deletion.
  for (const resource of [...created].reverse()) {
    try { const actual = owned(resource); if (resource.kind === 'container') { if (actual.State.Running) docker(['container', 'stop', '--time', '10', resource.name]); docker(['container', 'rm', resource.name]); } else docker([resource.kind, 'rm', resource.name]); }
    catch (error) { failure ??= error; console.error('Cleanup blocked for exact owned resource: ' + resource.name); }
  }
}
console.log(JSON.stringify({ passed: results.length, planned: scenarios.length, resourcesCreated: created.length, cleanupAttempted: true, success: !failure }));
if (failure) throw failure;
