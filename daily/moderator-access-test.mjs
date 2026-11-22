import assert from 'node:assert/strict';
import { cancelCommand, mayManageActivity } from './moderator-access.mjs';

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
