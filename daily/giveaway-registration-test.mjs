import assert from 'node:assert/strict';
import { registerGiveaway, giveawayTrackCommand } from './giveaway-registration.mjs';

const guildId='10000000000000001',channelId='10000000000000002',boatId='10000000000000003',messageId='10000000000000004';
const message={id:messageId,channelId,author:{id:boatId},createdTimestamp:Date.parse('2026-11-22T03:56:00Z'),components:[{components:[{customId:'giveaway_message'}]}]};
const channel={guildId,messages:{fetch:async()=>message}};
const guild={id:guildId,channels:{fetch:async()=>channel}};
let saved;
const sql=async(strings,...values)=>{
  if (strings.join('?').startsWith('INSERT')) { if (!saved) saved={channel_id:values[1],message_id:values[2]}; return []; }
  return saved ? [saved] : [];
};
const args={guild,channelId,boatId,day:'2026-11-22',messageId,sql};
assert.equal(giveawayTrackCommand.toJSON().default_member_permissions,'0');
await assert.rejects(registerGiveaway({...args,day:'2026-02-30'}),/INVALID/);
await assert.rejects(registerGiveaway({...args,day:'2026-11-21'}),/UNVERIFIED/);
message.author.id='10000000000000005';
await assert.rejects(registerGiveaway(args),/UNVERIFIED/);
message.author.id=boatId;
await registerGiveaway(args);
await registerGiveaway(args);
saved.message_id='10000000000000006';
await assert.rejects(registerGiveaway(args),/CONFLICT/);
console.log('giveaway registration tests passed');
