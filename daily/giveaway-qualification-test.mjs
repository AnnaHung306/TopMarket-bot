import assert from 'node:assert/strict';
import { ChannelType, Collection, MessageType } from 'discord.js';
import { createGiveawayQualification } from './giveaway-qualification.mjs';
import { eventTimes } from './time.mjs';

const userId='10000000000000001', guildId='10000000000000002', roleId='10000000000000003';
let time=eventTimes('2026-11-20','giveaway').start+1000;
let record, present=false, adds=0, removes=0;
const member={roles:{cache:{has:()=>present},add:async()=>{present=true;adds++;},remove:async()=>{present=false;removes++;}}};
const channel={parentId:'group',type:ChannelType.GuildText,permissionsFor:()=>({has:()=>true}),messages:{fetch:async()=>new Collection(Array.from({length:20},(_,i)=>[String(i),{id:String(i),createdTimestamp:eventTimes('2026-11-20','giveaway').start+i,type:MessageType.Default,author:{id:userId,bot:false}}]))}};
const guild={roles:{fetch:async()=>({position:1})},members:{me:{permissions:{has:()=>true},roles:{highest:{position:2}}},fetch:async()=>member},channels:{fetch:async()=>channel}};
const sql=async (strings,...values)=>{
  const query=strings.join('?');
  if(query.startsWith('SELECT user_id')) return record?[record]:[];
  if(query.startsWith('INSERT INTO daily_giveaway_role_grants')) {record={user_id:values[0],activity_day:values[1]};return [];}
  if(query.startsWith('DELETE FROM daily_giveaway_role_grants')) {record=undefined;return [];}
  return [];
};
const bridge=createGiveawayQualification({guildId,roleId,testerId:userId,channelIds:['channel'],categoryId:'group',client:{guilds:{fetch:async()=>guild}},sql,now:()=>time});
await bridge.tick();
assert.equal(adds,1);
assert.equal(record.activity_day,'2026-11-20');
await bridge.tick();
assert.equal(adds,1);
time=eventTimes('2026-11-20','giveaway').end;
await bridge.tick();
assert.equal(removes,0,'keep eligibility after close for delayed result');
time=eventTimes('2026-11-23','giveaway').start+1000;
await bridge.tick();
assert.equal(removes,1,'clear prior grant when next activity starts');
assert.equal(present,false);
assert.equal(record,undefined);
console.log('giveaway role bridge tests passed');
