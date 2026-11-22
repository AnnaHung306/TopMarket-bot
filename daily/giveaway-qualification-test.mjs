import assert from 'node:assert/strict';
import { ChannelType, Collection, MessageType } from 'discord.js';
import { createGiveawayQualification } from './giveaway-qualification.mjs';
import { createMemberGiveawayQualification, qualifyingMembers } from './giveaway-members.mjs';
import { eventTimes } from './time.mjs';

const userId='10000000000000001', guildId='10000000000000002', roleId='10000000000000003', boatId='10000000000000004', testChannelId='10000000000000005', messageId='10000000000000006';
let time=eventTimes('2026-11-20','giveaway').start+1000;
let record, present=false, adds=0, removes=0, disqualified=false, registration;
const member={roles:{cache:{has:()=>present},add:async()=>{present=true;adds++;},remove:async()=>{present=false;removes++;}}};
const channel={parentId:'group',type:ChannelType.GuildText,permissionsFor:()=>({has:()=>true}),messages:{fetch:async()=>new Collection(Array.from({length:20},(_,i)=>[String(i),{id:String(i),createdTimestamp:eventTimes('2026-11-20','giveaway').start+i,type:MessageType.Default,author:{id:userId,bot:false}}]))}};
const ended={id:messageId,channelId:testChannelId,author:{id:boatId},content:'🎊 **GIVEAWAY ENDED** 🎊',embeds:[{description:`Winner: <@${userId}>`,timestamp:'2026-11-21T02:00:00Z',footer:{text:'Ended at'}}],components:[{components:[{customId:'giveaway_message',disabled:true}]}]};
const testChannel={guildId,messages:{fetch:async()=>ended}};
const guild={id:guildId,roles:{fetch:async()=>({position:1})},members:{me:{permissions:{has:()=>true},roles:{highest:{position:2}}},fetch:async()=>member},channels:{fetch:async id=>id === testChannelId ? testChannel : new Collection([['channel',channel]])}};
const sql=async (strings,...values)=>{
  const query=strings.join('?');
  if(query.startsWith('SELECT 1 FROM daily_disqualifications')) return disqualified ? [{'?column?':1}] : [];
  if(query.startsWith('SELECT channel_id,message_id')) return registration ? [registration] : [];
  if(query.startsWith('SELECT user_id')) return record?[record]:[];
  if(query.startsWith('INSERT INTO daily_giveaway_role_grants')) {record={user_id:values[0],activity_day:values[1]};return [];}
  if(query.startsWith('DELETE FROM daily_giveaway_role_grants')) {record=undefined;return [];}
  return [];
};
const bridge=createGiveawayQualification({guildId,roleId,testerId:userId,boatId,testChannelId,channelIds:['channel'],categoryId:'group',client:{guilds:{fetch:async()=>guild}},sql,now:()=>time});
await bridge.tick();
assert.equal(adds,1);
assert.equal(record.activity_day,'2026-11-20');
await bridge.tick();
assert.equal(adds,1);
disqualified=true;
await bridge.tick();
assert.equal(present,false,'disqualified user loses the role');
await bridge.tick();
assert.equal(adds,1,'reconciliation must not restore cancelled eligibility');
disqualified=false;
await bridge.tick();
assert.equal(adds,2);
removes=0;
time=eventTimes('2026-11-20','giveaway').end;
await bridge.tick();
assert.equal(removes,0,'keep eligibility after close for delayed result');
time=eventTimes('2026-11-20','giveaway').end+3600000; // Saturday report time, with no new activity
await assert.rejects(bridge.tick(), /DAILY_GIVEAWAY_PRIOR_DRAW_UNCONFIRMED/);
assert.equal(removes,0,'do not remove role before Giveaway Boat draw is confirmed');
assert.equal(present,true);
assert.equal(record.activity_day,'2026-11-20');
registration={channel_id:testChannelId,message_id:messageId};
await bridge.tick();
assert.equal(removes,1,'confirmed previous draw permits removal without participant-list delivery');
assert.equal(present,false);
assert.equal(record,undefined);
console.log('giveaway role bridge tests passed');

// General-member mode: discover multiple qualified authors from metadata,
// respect individual cancellations, and refuse unknown prior draw results.
const other='10000000000000008', groupId='10000000000000009', day='2026-11-23';
const snapshots=Array.from({length:41},(_,i)=>({id:String(10000000000000100n+BigInt(i)),createdTimestamp:eventTimes(day,'giveaway').start+i,type:MessageType.Default,author:{id:i<20?userId:other,bot:false}})).reverse();
const groupChannel={id:'g',parentId:groupId,type:ChannelType.GuildText,permissionsFor:()=>({has:()=>true}),messages:{fetch:async()=>new Collection(snapshots.map(m=>[m.id,m]))}};
const fetched={id:messageId,channelId:testChannelId,author:{id:boatId},components:[{components:[{customId:'giveaway_message',disabled:false}]}]};
const roleMembers=new Map([[userId,{user:{bot:false},manageable:true,has:false}],[other,{user:{bot:false},manageable:true,has:false}]]);
for(const member of roleMembers.values())member.roles={cache:{has:()=>member.has},add:async()=>{member.has=true;},remove:async()=>{member.has=false;}};
const groupGuild={id:guildId,roles:{fetch:async()=>({position:1})},members:{me:guild.members.me,fetch:async({user})=>roleMembers.get(user)},channels:{fetch:async id=>id===testChannelId?{guildId,messages:{fetch:async()=>fetched}}:new Collection([['g',groupChannel]])}};
assert.deepEqual(new Set(await qualifyingMembers({guild:groupGuild,categoryId:groupId,start:eventTimes(day,'giveaway').start,end:eventTimes(day,'giveaway').start+1000})),new Set([userId,other]));
let dayNow=eventTimes(day,'giveaway').start+1000;
const grants=new Map(), sessions=new Map([[day,{channel_id:testChannelId,message_id:messageId}]]), cancelled=new Set([other]);
const memberSql=async(parts,...values)=>{
  const q=parts.join('?');
  if(q.startsWith('SELECT user_id,activity_day'))return [...grants].map(([user_id,activity_day])=>({user_id,activity_day}));
  if(q.startsWith('SELECT channel_id,message_id'))return sessions.has(values[0])?[sessions.get(values[0])]:[];
  if(q.startsWith('SELECT 1 FROM daily_disqualifications'))return cancelled.has(values[1])?[{}]:[];
  if(q.startsWith('SELECT activity_day FROM daily_giveaway_role_grants'))return grants.has(values[0])?[{activity_day:grants.get(values[0])}]:[];
  if(q.startsWith('INSERT INTO daily_giveaway_role_grants')){grants.set(values[0],values[1]);return [];}
  if(q.startsWith('DELETE FROM daily_giveaway_role_grants')){grants.delete(values[0]);return [];}
  throw Error(`Unexpected SQL ${q}`);
};
const membersBridge=createMemberGiveawayQualification({guildId,roleId,boatId,channelId:testChannelId,categoryId:groupId,client:{guilds:{fetch:async()=>groupGuild}},sql:memberSql,now:()=>dayNow});
await membersBridge.tick();
assert.equal(roleMembers.get(userId).has,true);
assert.equal(roleMembers.get(other).has,false,'a cancelled member must not regain the role');
await membersBridge.tick();assert.equal(grants.size,1);
dayNow=eventTimes(day,'giveaway').end+3600000;
await assert.rejects(membersBridge.tick(),/PRIOR_DRAW_UNCONFIRMED/);
assert.equal(roleMembers.get(userId).has,true,'unconfirmed draw must retain old roles');
Object.assign(fetched,ended,{channelId:testChannelId});
await assert.rejects(membersBridge.tick(),/SESSION_UNREGISTERED/);
assert.equal(roleMembers.get(userId).has,false);assert.equal(grants.size,0);
console.log('general giveaway qualification tests passed');
