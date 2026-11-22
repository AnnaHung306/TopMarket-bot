import assert from 'node:assert/strict';
import { ChannelType, Collection, MessageFlags, MessageType } from 'discord.js';
import { createDailyModule } from './index.mjs';
import { eventTimes } from './time.mjs';

const guildId='10000000000000001',channelId='10000000000000002',modId='10000000000000003',role='10000000000000004',category='10000000000000005',botRole='10000000000000006',boat='10000000000000007',user='10000000000000008',source='10000000000000009';
const day='2026-11-20', start=eventTimes(day,'quiz').start;
let time=start+60000, count=9, stored, disqualified=false;
const chat={parentId:category,type:ChannelType.GuildText,permissionsFor:()=>({has:()=>true}),messages:{fetch:async()=>new Collection(Array.from({length:count},(_,i)=>[String(i),{id:String(i),createdTimestamp:start+i+1,type:MessageType.Default,author:{id:user,bot:false}}]))}};
const guild={members:{me:{}},channels:{fetch:async()=>new Collection([['chat',chat]])}};
const event={message_id:source,result:null,question:'測試題？',options:['選項一','選項二','選項三','選項四']};
const sql=async(parts,...values)=>{
  const q=parts.join('?');
  if(q.startsWith('SELECT message_id,result,question,options')) return [event];
  if(q.startsWith('SELECT 1 FROM daily_entries')) return stored?[stored]:[];
  if(q.startsWith('SELECT 1 FROM daily_disqualifications')) return disqualified?[{}]:[];
  if(q.startsWith('INSERT INTO daily_quiz_questions')) return [];
  if(q.startsWith('INSERT INTO daily_entries')) {if(stored||disqualified)return [];stored={answer:values[3]};return [{user_id:user}];}
  throw Error(`Unexpected query ${q}`);
};
const env={DAILY_GUILD_ID:guildId,DAILY_CHANNEL_ID:channelId,DAILY_MOD_CHANNEL_ID:modId,DAILY_GROUP_CATEGORY_ID:category,DAILY_MODERATOR_ROLE_ID:role,DAILY_BOT_ROLE_ID:botRole,DAILY_GIVEAWAY_BOAT_ID:boat};
const daily=createDailyModule({client:{},sql,env,now:()=>time,logger:{error:(...args)=>{throw Error(String(args));}}});
assert.equal(daily.commands.find(command=>command.name==='dailyquiz').default_member_permissions,'0');
for (const rejected of [
  {guildId,channelId:modId,member:{roles:{cache:new Map()}}},
  {guildId,channelId,member:{roles:{cache:new Map([[role,true]])}}},
  {guildId:'10000000000000099',channelId:modId,member:{roles:{cache:new Map([[role,true]])}}},
]) {
  let reply;
  await daily.handle({...rejected,commandName:'dailyquiz',isChatInputCommand:()=>true,reply:async value=>{reply=value;}});
  if (rejected.guildId !== guildId) assert.equal(reply,undefined);
  else assert.match(reply.content,/僅限 MOD/);
}
let modReply;
await daily.handle({guildId,channelId:modId,member:{roles:{cache:new Map([[role,true]])}},user:{id:user},commandName:'dailyquiz',isChatInputCommand:()=>true,options:{getString:key=>({date:'2026-11-23',question:'測試題',a:'一',b:'二',c:'三',d:'四',correct:'A'})[key]},reply:async value=>{modReply=value;}});
assert.match(modReply.content,/已設定 2026-11-23/);
function interaction(customId,who=user,messageId=source) {
  const calls=[];
  return {guildId,channelId,guild,user:{id:who},message:{id:messageId},customId,isChatInputCommand:()=>false,isButton:()=>true,
    reply:async x=>calls.push(['reply',x]),deferReply:async x=>calls.push(['deferReply',x]),deferUpdate:async()=>calls.push(['deferUpdate']),editReply:async x=>calls.push(['editReply',x]),calls};
}
let i=interaction(`daily:quiz:${day}:join`);
await daily.handle(i);
assert.equal(i.calls[0][1].flags,MessageFlags.Ephemeral);
assert.match(i.calls.at(-1)[1].content,/尚未達到/);
assert.equal(i.calls.at(-1)[1].components.length,0);
i=interaction(`daily:quiz:${day}:A`);
await daily.handle(i);
assert.match(i.calls[0][1].content,/已過期或無效/);
count=10;
i=interaction(`daily:quiz:${day}:join`);
await daily.handle(i);
const selection=i.calls.at(-1)[1];
assert.match(selection.content,/A\. 選項一/);
assert.equal(selection.components[0].components.length,4);
assert.equal(stored,undefined,'viewing options must not submit an answer');
const id=selection.components[0].components[1].data.custom_id;
i=interaction(id,'10000000000000010','10000000000000011');
await daily.handle(i);
assert.match(i.calls[0][1].content,/不屬於/);
assert.equal(stored,undefined);
i=interaction(id,user,'10000000000000011');
await daily.handle(i);
assert.equal(i.calls[0][0],'deferUpdate');
assert.match(i.calls.at(-1)[1].content,/已提交答案 B/);
assert.equal(stored.answer,'B');
i=interaction(id,user,'10000000000000011');
await daily.handle(i);
assert.match(i.calls.at(-1)[1].content,/不能修改/);
stored=undefined; disqualified=true;
i=interaction(`daily:quiz:${day}:join`);
await daily.handle(i);
assert.match(i.calls.at(-1)[1].content,/資格已被取消/);
disqualified=false; time=eventTimes(day,'quiz').end;
i=interaction(id,user,'10000000000000011');
await daily.handle(i);
assert.match(i.calls.at(-1)[1].content,/已截止/);
assert.equal(stored,undefined);
console.log('quiz eligibility and private answer interaction tests passed');

// Public-mode safety checks are simulated locally, without Discord calls.
const unverified='10000000000000012', botId='10000000000000013';
const unverifiedRole={permissions:{has:()=>false}};
const ow=(key,allow=false,deny=false)=>({id:key,allow:{has:()=>allow},deny:{has:()=>deny}});
const permissions=(viewer)=>({has:()=>viewer!==unverifiedRole});
const activityChannel={id:channelId,type:ChannelType.GuildText,permissionsFor:permissions,permissionOverwrites:{cache:new Map([[guildId,ow(guildId,true)],[unverified,ow(unverified,false,true)]])}};
const moderatorChannel={id:modId,type:ChannelType.GuildText,permissionsFor:permissions,permissionOverwrites:{cache:new Map([[guildId,ow(guildId,false,true)],[role,ow(role,true)]])}};
let isUnverified=true, fetches=0, revokeOnFetch=Infinity;
const publicGuild={...guild,id:guildId,roles:{cache:new Map([[unverified,unverifiedRole]]),fetch:async()=>unverifiedRole},members:{me:{},fetch:async()=>({roles:{cache:{has:()=>isUnverified || ++fetches>=revokeOnFetch}}})},channels:{fetch:async id=>id===channelId?activityChannel:id===modId?moderatorChannel:new Collection([['chat',chat]])}};
const publicDaily=createDailyModule({client:{user:{id:botId},guilds:{fetch:async()=>publicGuild}},sql,env:{...env,DAILY_PUBLIC_ACTIVITY_ENABLED:'true',DAILY_UNVERIFIED_ROLE_ID:unverified},now:()=>time,logger:{error:(...args)=>{throw Error(String(args));}}});
time=start+60000; stored=undefined;
i=interaction(`daily:quiz:${day}:join`); i.guild=publicGuild;
await publicDaily.handle(i);
assert.match(i.calls.at(-1)[1].content,/尚未完成伺服器驗證/);
assert.equal(i.calls.at(-1)[1].components.length,0);
isUnverified=false; fetches=0; revokeOnFetch=2;
i=interaction(`daily:quiz:${day}:join`); i.guild=publicGuild;
await publicDaily.handle(i);
assert.match(i.calls.at(-1)[1].content,/尚未完成伺服器驗證/,'role changes during eligibility checks must fail closed');
assert.equal(stored,undefined);
console.log('public quiz verification safety tests passed');
