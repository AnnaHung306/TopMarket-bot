import test from 'node:test';
import assert from 'node:assert/strict';
import { createProductionWalletV2 } from '../runtime.mjs';
import { walletLocationAllowed } from '../discord.mjs';

test('production V2 is explicit and incomplete configuration cannot silently enable an engine', async () => {
  assert.equal(await createProductionWalletV2({ env: {} }), null);
  await assert.rejects(createProductionWalletV2({ env: { WALLET_V2_ENABLED: 'true' } }), /missing ALCHEMY_API_KEY/);
  await assert.rejects(createProductionWalletV2({ env: { WALLET_V2_ENABLED: 'true', ALCHEMY_API_KEY: 'test-only' } }), /missing WALLET_V2_DATABASE_URL/);
});
test('mod-only wallet testing checks the actual guild and moderator role, including its threads', () => {
  const policy = { guildId: '111111111111111111', modChannelId: '222222222222222222', moderatorRoleId: '333333333333333333' };
  const member = { roles: { cache: new Map([[policy.moderatorRoleId, {}]]) } };
  const base = { guildId: policy.guildId, channelId: policy.modChannelId, member, channel: { isThread: () => false } };
  const toolbox = '444444444444444444';
  assert.equal(walletLocationAllowed(base, toolbox, policy), true);
  assert.equal(walletLocationAllowed({ ...base, member: { roles: { cache: new Map() } } }, toolbox, policy), false);
  assert.equal(walletLocationAllowed({ ...base, guildId: '555555555555555555' }, toolbox, policy), false);
  assert.equal(walletLocationAllowed({ ...base, channelId: '666666666666666666', channel: { isThread: () => true, parentId: policy.modChannelId } }, toolbox, policy), true);
  assert.equal(walletLocationAllowed(base, '', policy), false);
  assert.equal(walletLocationAllowed({ ...base, channelId: toolbox }, toolbox, {}), true);
});
