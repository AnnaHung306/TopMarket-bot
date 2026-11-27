import assert from 'node:assert/strict';
import {createMemberGiveawayQualification} from './giveaway-members.mjs';
import {eventTimes} from './time.mjs';

const guildId='10000000000000001',roleId='10000000000000002',boatId='10000000000000003',channelId='10000000000000004',categoryId='10000000000000005',a='10000000000000006',b='10000000000000007';
let time=eventTimes('2026-11-30','giveaway').start-3600000, row, scans=0;
const held=new Set([a,b]),logs=[];
const makeMember=id=>({id,user:{bot:false},manageable:true,roles:{cache:{has:role=>role===roleId&&held.has(id)},remove:async()=>{logs.push(`remove:${id}`);held.delete(id);},add:async()=>{logs.push(`add:${id}`);held.add(id);}}});
const members=new Map([[a,makeMember(a)],[b,makeMember(b)]]);
const guild={roles:{fetch:async()=>({position:1})},members:{me:{permissions:{has:()=>true},roles:{highest:{position:2}}},fetch:async options=>options.user?members.get(options.user):members},fetch:async()=>({memberCount:2})};
const sql=async (parts,...v)=>{
  const q=parts.join('?');
  if(q.startsWith('SELECT owner_id')) return row?[row]:[];
  if(q.startsWith('INSERT INTO daily_giveaway_fixed_role_resets')) {row={owner_id:v[1],completed_at:null};return [{owner_id:v[1]}];}
  if(q.startsWith('UPDATE daily_giveaway_fixed_role_resets')) {row.completed_at='done';return [];}
  if(q.startsWith('SELECT user_id,activity_day')||q.startsWith('SELECT 1 FROM daily_disqualifications')||q.startsWith('INSERT INTO daily_giveaway_member_role_grants')) return [];
  throw Error(`unexpected query ${q}`);
};
const service=createMemberGiveawayQualification({guildId,roleId,boatId,channelId,categoryId,client:{guilds:{fetch:async()=>guild}},sql,now:()=>time,fixedResetFrom:'2026-11-30',collect:async()=>{scans++;return [a];}});
await service.tick();assert.deepEqual([...held],[]);assert.equal(scans,0,'09:00-10:00 does not count');
time+=3600000;await service.tick();assert.deepEqual([...held],[a]);assert.equal(scans,1);
await service.tick();assert.deepEqual([...held],[a]);assert.equal(logs.filter(x=>x.startsWith('remove:')).length,2,'same day never resets twice');
console.log('fixed role reset and same-day requalification passed');
