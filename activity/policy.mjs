const address = /^0x[0-9a-f]{40}$/;
const hash = /^0x[0-9a-f]{64}$/;
export class ActivityPolicyError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = code => { throw new ActivityPolicyError(code); };

/** Only server-declared policy and the enrolled, fixed roster authorize a selection. */
export function readCountingPolicy(task, walletAddresses) {
  if (!task || !['per_user', 'per_wallet'].includes(task.counting_mode) || !Number.isInteger(task.wallet_limit) || task.wallet_limit < 1 || task.wallet_limit > 3 || !Array.isArray(walletAddresses)) fail('ACTIVITY_POLICY_UNAVAILABLE');
  const policyHash = task.counting_policy_hash;
  const validHash = typeof policyHash === 'string' && hash.test(policyHash);
  if (task.counting_mode === 'per_wallet' ? !validHash : policyHash !== null && !validHash) fail('ACTIVITY_POLICY_UNAVAILABLE');
  if (walletAddresses.some(item => typeof item !== 'string' || !address.test(item)) || new Set(walletAddresses).size !== walletAddresses.length) fail('ACTIVITY_ROSTER_INVALID');
  if (task.counting_mode === 'per_wallet' ? walletAddresses.length < 1 || walletAddresses.length > task.wallet_limit : walletAddresses.length !== 0) fail('ACTIVITY_ROSTER_INVALID');
  return Object.freeze({ countingMode: task.counting_mode, walletLimit: task.wallet_limit, countingPolicyHash: policyHash,
    walletAddresses: Object.freeze([...walletAddresses].sort()) });
}
export function readRoster(value, activityId, discordUserId) {
  if (value?.activity_id !== activityId || value.discord_user_id !== discordUserId || !Array.isArray(value.wallets)) fail('ACTIVITY_ROSTER_INVALID');
  return readCountingPolicy(value, value.wallets.map(item => item?.address));
}
export function readLinkPolicy(link) {
  return readCountingPolicy({ counting_mode: link?.countingMode, wallet_limit: link?.walletLimit, counting_policy_hash: link?.countingPolicyHash }, link?.walletAddresses);
}
export function assertSamePolicy(left, right) {
  if (JSON.stringify(left) !== JSON.stringify(right)) fail('ACTIVITY_POLICY_CHANGED');
}
export function submissionPolicy(policy, selectedWallet) {
  if (policy.countingMode === 'per_user') {
    if (selectedWallet !== null && selectedWallet !== undefined) fail('ACTIVITY_WALLET_NOT_APPLICABLE');
    return Object.freeze({});
  }
  if (typeof selectedWallet !== 'string' || !selectedWallet.trim()) fail('ACTIVITY_WALLET_REQUIRED');
  const wallet = selectedWallet.trim().toLowerCase();
  if (!address.test(wallet) || !policy.walletAddresses.includes(wallet)) fail('ACTIVITY_WALLET_NOT_ENROLLED');
  return Object.freeze({ submission_version: 2, wallet_address: wallet, policy_hash: policy.countingPolicyHash });
}
