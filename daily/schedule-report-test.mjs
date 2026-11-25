import assert from 'node:assert/strict';
import { ChannelType, Collection, PermissionFlagsBits } from 'discord.js';
import { createDailyModule } from './index.mjs';

const guildId='10000000000000001', channelId='10000000000000002', modId='10000000000000003', moderator='10000000000000004', botRole='10000000000000005', boat='10000000000000006', category='10000000000000007', botId='10000000000000008';
const event={day:'2026-11-20',kind:'quiz',question:'哪一個是正確答案？',options:['選項一','選項二','選項三','選項四'],correct:'B',message_id:'message',result:null,result_message_id:null,mod_result_message_id:null,mod_notice:null};
let time=Date.parse('2026-11-21T00:59:59Z'), sent=[], edits=0, page;
const overwrite=new Map([[guildId,{id:guildId,deny:{has:bit=>bit===PermissionFlagsBits.ViewChannel},allow:{has:()=>false}}],[moderator,{id:moderator,allow:{has:bit=>bit===PermissionFlagsBits.ViewChannel}}]]);
const channel={id:channelId,type:ChannelType.GuildText,permissionOverwrites:{cache:overwrite},permissionsFor:()=>({has:()=>true}),messages:{fetch:async arg=>typeof arg==='string'?{edit:async()=>{edits++;}}:new Collection()},send:async payload=>{sent.push(payload);return {id:'sent'};}};
const modChannel={...channel,id:modId};
const guild={id:guildId,members:{me:{}},channels:{fetch:async id=>id===channelId?channel:modChannel}};
const client={user:{id:botId},guilds:{fetch:async()=>guild}};
const sql=async(parts,...values)=>{
  const q=parts.join('?');
  if(q.startsWith('SELECT * FROM daily_quiz_questions')) return [{question:'test',options:['a','b','c','d'],correct:'A'}];
  if(q.startsWith('INSERT INTO daily_events(day,kind,question')) return [];
  if(q.startsWith('SELECT * FROM daily_events WHERE day=')) return values[0]===event.day?[event]:[{day:values[0],kind:'quiz',message_id:'next-message'}];
  if(q.startsWith('SELECT user_id FROM daily_entries')) return [];
  if(q.startsWith('UPDATE daily_events SET result=')) {event.result=JSON.parse(values[0]);return [{result:event.result}];}
  if(q.startsWith('UPDATE daily_events SET result_message_id=')) {event.result_message_id=values[0];return [];}
  if(q.includes("kind='quiz' AND result IS NULL AND message_id IS NOT NULL")) return [];
  if(q.includes("kind = 'quiz' AND (result_message_id")) return event.mod_result_message_id?[]:[event];
  if(q.includes('FROM discord_repeat_incidents')) return [];
  if(q.startsWith('UPDATE daily_events SET mod_notice=')) { event.mod_notice=JSON.parse(values[0]); return [{mod_notice:event.mod_notice}]; }
  if(q.startsWith('SELECT message_id FROM daily_mod_notice_pages')) return page?[{message_id:page}]:[];
  if(q.startsWith('INSERT INTO daily_mod_notice_pages')) {page=values[3];return [];}
  if(q.startsWith('UPDATE daily_events SET mod_result_message_id=')) {event.mod_result_message_id=values[0];return [];}
  throw Error(`Unexpected query: ${q}`);
};
const env={DAILY_GUILD_ID:guildId,DAILY_CHANNEL_ID:channelId,DAILY_MOD_CHANNEL_ID:modId,DAILY_GROUP_CATEGORY_ID:category,DAILY_MODERATOR_ROLE_ID:moderator,DAILY_BOT_ROLE_ID:botRole,DAILY_GIVEAWAY_BOAT_ID:boat};
let failures=[];
const daily=createDailyModule({client,sql,env,now:()=>time,logger:{error:(...x)=>failures.push(x)}});
await daily.tick();
assert.deepEqual(failures,[]);
assert.equal(edits,0); assert.equal(sent.length,0);
time=Date.parse('2026-11-21T01:00:00Z'); // Saturday 09:00 Taipei
await daily.tick();
assert.equal(edits,1); assert.equal(sent.length,1); assert.match(sent[0].content,/每日答題結果/);
assert.match(sent[0].content,/正確答案：B．選項二/);
time=Date.parse('2026-11-21T01:59:59Z');
await daily.tick();
assert.equal(sent.length,1);
time=Date.parse('2026-11-21T02:00:00Z'); // Saturday 10:00 Taipei
await daily.tick();
assert.equal(sent.length,2); assert.match(sent[1].content,/2026-11-20 每日答題發獎清單/);
assert.equal(failures.length,0);
console.log('Saturday quiz close and report schedule tests passed');
