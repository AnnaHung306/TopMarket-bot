import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readCountingPolicy, readRoster, readLinkPolicy, assertSamePolicy, submissionPolicy } from './policy.mjs';
import { canonicalize, sourceGenesis, sourceEnvelopeHash, makeSourceEnvelope, submissionFingerprint } from './protocol.mjs';

const W1 = '0x' + '1'.repeat(40), W2 = '0x' + '2'.repeat(40), W3 = '0x' + '3'.repeat(40), HASH = '0x' + 'a'.repeat(64);
const task = { counting_mode: 'per_wallet', wallet_limit: 3, counting_policy_hash: HASH };
const code = value => error => error.code === value;
test('only explicit, fixed server roster choices produce v2; even one wallet is never selected implicitly', () => {
  const policy = readCountingPolicy(task, [W2, W1]);
  assert.ok(Object.isFrozen(policy)); assert.ok(Object.isFrozen(policy.walletAddresses));
  assert.deepEqual(policy.walletAddresses, [W1, W2]); assertSamePolicy(policy, readLinkPolicy(policy));
  assert.deepEqual(submissionPolicy(policy, W2.toUpperCase()), { submission_version: 2, wallet_address: W2, policy_hash: HASH });
  for (const wallet of [null, undefined, '']) assert.throws(() => submissionPolicy(readCountingPolicy({ ...task, wallet_limit: 1 }, [W1]), wallet), code('ACTIVITY_WALLET_REQUIRED'));
  assert.throws(() => submissionPolicy(policy, W3), code('ACTIVITY_WALLET_NOT_ENROLLED'));
  assert.throws(() => assertSamePolicy(policy, readCountingPolicy({ ...task, counting_policy_hash: '0x' + 'b'.repeat(64) }, [W1, W2])), code('ACTIVITY_POLICY_CHANGED'));
});
test('unknown policy, foreign identity, malformed or oversized roster and unnecessary per-user wallet fail closed', () => {
  for (const invalid of [{}, { ...task, counting_mode: 'unknown' }, { ...task, wallet_limit: 4 }, { ...task, wallet_limit: '3' }, { ...task, counting_policy_hash: null }]) assert.throws(() => readCountingPolicy(invalid, [W1]), code('ACTIVITY_POLICY_UNAVAILABLE'));
  for (const wallets of [[], [W1, W1], [W1.toUpperCase()], [W1, W2, W3, '0x' + '4'.repeat(40)]]) assert.throws(() => readCountingPolicy(task, wallets), code('ACTIVITY_ROSTER_INVALID'));
  assert.throws(() => readCountingPolicy({ ...task, wallet_limit: 1 }, [W1, W2]), code('ACTIVITY_ROSTER_INVALID'));
  const roster = { activity_id: 'activity', discord_user_id: 'owner', ...task, wallets: [{ address: W1 }] };
  assert.throws(() => readRoster(roster, 'activity', 'another'), code('ACTIVITY_ROSTER_INVALID'));
  assert.throws(() => readRoster(roster, 'another', 'owner'), code('ACTIVITY_ROSTER_INVALID'));
  assert.deepEqual(readRoster(roster, 'activity', 'owner').walletAddresses, [W1]);
  const perUser = readCountingPolicy({ counting_mode: 'per_user', wallet_limit: 3, counting_policy_hash: null }, []);
  assert.deepEqual(submissionPolicy(perUser, null), {});
  for (const wallet of ['', W1]) assert.throws(() => submissionPolicy(perUser, wallet), code('ACTIVITY_WALLET_NOT_APPLICABLE'));
});
test('legacy UTF-8 canonical vectors, genesis, envelope and semantic fingerprint remain byte-for-byte identical', () => {
  const v = JSON.parse(readFileSync(new URL('./protocol.vectors.json', import.meta.url), 'utf8'));
  assert.equal(sourceGenesis(v.genesis.input.streamId, v.genesis.input.guildId, v.genesis.input.scope), v.genesis.hash);
  assert.equal(canonicalize(v.envelope.input), v.envelope.canonical); assert.equal(sourceEnvelopeHash(v.envelope.input), v.envelope.hash);
  assert.equal(submissionFingerprint(v.semanticFingerprint.input), v.semanticFingerprint.hash);
  assert.equal(submissionFingerprint(v.semanticFingerprint.equivalentUrlInput), v.semanticFingerprint.hash);
});
test('v2 fingerprint binds wallet, policy and version while envelope shape and URL-query semantics remain stable', () => {
  const legacy = JSON.parse(readFileSync(new URL('./protocol.vectors.json', import.meta.url), 'utf8')).semanticFingerprint.input;
  const event = { ...legacy, submission_version: 2, wallet_address: W1, policy_hash: HASH }, fingerprint = submissionFingerprint(event);
  assert.notEqual(fingerprint, submissionFingerprint(legacy));
  assert.notEqual(fingerprint, submissionFingerprint({ ...event, wallet_address: W2 }));
  assert.notEqual(fingerprint, submissionFingerprint({ ...event, policy_hash: '0x' + 'b'.repeat(64) }));
  assert.equal(fingerprint, submissionFingerprint({ ...event, evidence: [{ ...event.evidence[0], url: event.evidence[0].url + '&ex=renewed' }] }));
  for (const invalid of [{ ...event, submission_version: 3 }, { ...event, submission_version: '2' }, { ...event, wallet_address: W1.toUpperCase() }, { ...event, policy_hash: null }, { ...legacy, wallet_address: W1 }]) assert.throws(() => submissionFingerprint(invalid));
  const envelope = makeSourceEnvelope({ streamId: 'stream', sequence: '9007199254740993', previousHash: HASH, kind: 'submission', payload: event });
  assert.deepEqual(Object.keys(envelope).sort(), ['hash', 'kind', 'payload', 'previousHash', 'sequence', 'streamId']);
  assert.notEqual(envelope.hash, makeSourceEnvelope({ ...envelope, payload: { ...event, wallet_address: W2 } }).hash);
});
test('independent Python v2 canonical bytes, semantic fingerprint and envelope hashes match fixed known vectors', () => {
  const v = JSON.parse(readFileSync(new URL('./protocol.v2.vectors.json', import.meta.url), 'utf8'));
  assert.equal(sourceGenesis(v.genesis.input.streamId, v.genesis.input.guildId, v.genesis.input.scope), v.genesis.hash);
  assert.equal(canonicalize(v.envelope.input), v.envelope.canonical); assert.equal(sourceEnvelopeHash(v.envelope.input), v.envelope.hash);
  assert.equal(makeSourceEnvelope(v.envelope.input).hash, v.envelope.hash);
  assert.equal(submissionFingerprint(v.semanticFingerprint.input), v.semanticFingerprint.hash);
});
