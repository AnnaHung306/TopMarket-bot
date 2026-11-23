import assert from 'node:assert/strict';
import { cancelCommand, mayManageActivity } from './moderator-access.mjs';
import { assertActivityChannelPolicy } from './channel-policy.mjs';

const settings = { guildId: 'guild', modChannelId: 'private', moderatorRoleId: 'mod' };
const interaction = { guildId: 'guild', channelId: 'private', member: { roles: { cache: new Map([['mod', true]]) } } };
assert.equal(mayManageActivity(interaction, settings), true);
assert.equal(mayManageActivity({ ...interaction, channelId: 'public' }, settings), false);
assert.equal(mayManageActivity({ ...interaction, guildId: 'other' }, settings), false);
assert.equal(mayManageActivity({ ...interaction, member: { roles: { cache: new Map() } } }, settings), false);
assert.equal(mayManageActivity({ ...interaction, member: null }, settings), false);
assert.equal(cancelCommand.toJSON().default_member_permissions, '0');
assert.deepEqual(cancelCommand.toJSON().options[0].choices.map(choice => choice.value), ['quiz','giveaway']);
console.log('moderator activity access tests passed');

const overwrite = (id, allow=false, deny=false) => ({id,allow:{has:()=>allow},deny:{has:()=>deny}});
const makeChannel = (id, entries, canView=false) => ({id,permissionOverwrites:{cache:new Map(entries.map(x=>[x.id,x]))},permissionsFor:()=>({has:()=>canView})});
const privateChannel=makeChannel('private',[overwrite('guild',false,true),overwrite('mod',true)]);
const publicChannel=makeChannel('public',[overwrite('guild',true),overwrite('unverified',false,true)]);
const policy={guild:{id:'guild',roles:{cache:new Map([['unverified',{permissions:{has:()=>false}}]])}},channel:publicChannel,modChannel:privateChannel,moderatorRoleId:'mod',botRoleId:'botrole',botId:'bot',boatId:'boat',publicEnabled:true,unverifiedRoleId:'unverified'};
assert.doesNotThrow(()=>assertActivityChannelPolicy(policy));
assert.throws(()=>assertActivityChannelPolicy({...policy,channel:makeChannel('public',[overwrite('guild',true)])}),/POLICY_INVALID/);
assert.throws(()=>assertActivityChannelPolicy({...policy,channel:makeChannel('public',[overwrite('guild',true),overwrite('unverified',false,true),overwrite('other',true)])}),/EXTRA_ACCESS/);
assert.throws(()=>assertActivityChannelPolicy({...policy,channel:makeChannel('public',[overwrite('guild',true),overwrite('unverified',false,true)],true)}),/UNVERIFIED_CAN_VIEW/);
assert.throws(()=>assertActivityChannelPolicy({...policy,modChannel:makeChannel('private',[overwrite('guild',false,true),overwrite('mod',true),overwrite('other',true)])}),/EXTRA_ACCESS/);
assert.throws(()=>assertActivityChannelPolicy({...policy,modChannel:publicChannel}),/COLLISION/);
assert.throws(()=>assertActivityChannelPolicy({...policy,publicEnabled:false}),/PRIVATE_CHANNEL_REQUIRED/);
assert.doesNotThrow(()=>assertActivityChannelPolicy({...policy,channel:privateChannel,publicEnabled:false}));
console.log('activity channel policy tests passed');

// The verified-only channel must deny everyone and unverified while allowing
// precisely the explicitly configured verified role.
const verifiedRole={permissions:{has:()=>false}};
const verifiedGuild={id:'guild',roles:{cache:new Map([['unverified',{permissions:{has:()=>false}}],['verified',verifiedRole]])}};
const verifiedChannel=makeChannel('public',[overwrite('guild',false,true),overwrite('unverified',false,true),overwrite('verified',true)]);
const verifiedPolicy={...policy,guild:verifiedGuild,channel:verifiedChannel,verifiedRoleId:'verified'};
assert.doesNotThrow(()=>assertActivityChannelPolicy(verifiedPolicy));
assert.throws(()=>assertActivityChannelPolicy({...verifiedPolicy,channel:makeChannel('public',[overwrite('guild',false,true),overwrite('unverified',false,true)])}),/POLICY_INVALID/);
assert.throws(()=>assertActivityChannelPolicy({...verifiedPolicy,channel:makeChannel('public',[overwrite('guild',false,true),overwrite('unverified',false,true),overwrite('verified',true),overwrite('other',true)])}),/EXTRA_ACCESS/);
assert.throws(()=>assertActivityChannelPolicy({...verifiedPolicy,verifiedRoleId:'unverified'}),/VERIFIED_ROLE_INVALID/);
console.log('verified-only channel policy tests passed');
