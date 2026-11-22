import assert from 'node:assert/strict';
import { createDailyModule } from './index.mjs';

const guild='10000000000000001', channel='10000000000000002', modChannel='10000000000000003';
const role='10000000000000004', category='10000000000000005', bot='10000000000000006', boat='10000000000000007';
const env={DAILY_GUILD_ID:guild,DAILY_CHANNEL_ID:channel,DAILY_MOD_CHANNEL_ID:modChannel,DAILY_GROUP_CATEGORY_ID:category,DAILY_MODERATOR_ROLE_ID:role,DAILY_BOT_ROLE_ID:bot,DAILY_GIVEAWAY_BOAT_ID:boat};
let queries=0;
const sql=async parts=>{queries++; const q=parts.join('?'); if(q.includes('FROM daily_events')) return [{message_id:'quiz-message',result:null}]; if(q.includes('FROM daily_entries')) return [{user_id:'10000000000000008'}]; if(q.includes('FROM discord_repeat_incidents')) return [{user_id:'10000000000000008',warnings:1,pending:1}]; throw Error('unexpected query');};
const daily=createDailyModule({client:{},sql,env,now:()=>Date.parse('2026-11-20T04:00:00Z')});
const published=daily.commands.find(c=>c.name==='activity-review');
assert.equal(published.default_member_permissions,'0');
function interaction(roles, channelId=modChannel, activity='quiz') {
  const calls=[];
  return {guildId:guild,channelId,member:{roles:{cache:new Map(roles.map(r=>[r,true]))}},commandName:'activity-review',isChatInputCommand:()=>true,options:{getString:()=>activity},reply:async x=>calls.push(['reply',x]),deferReply:async x=>calls.push(['defer',x]),editReply:async x=>calls.push(['edit',x]),followUp:async x=>calls.push(['follow',x]),calls};
}
const denied=interaction([]);
await daily.handle(denied);
assert.match(denied.calls[0][1].content,/僅限 MOD/);
assert.equal(queries,0);
const wrongChannel=interaction([role],channel);
await daily.handle(wrongChannel);
assert.match(wrongChannel.calls[0][1].content,/僅限 MOD/);
assert.equal(queries,0);
const unavailable=interaction([role],modChannel,'giveaway');
await daily.handle(unavailable);
assert.match(unavailable.calls[0][1].content,/尚無法取得/);
assert.equal(queries,0);
const authorized=interaction([role]);
await daily.handle(authorized);
assert.equal(authorized.calls[0][0],'defer');
assert.match(authorized.calls[1][1].content,/1 次提示（1 次待審核）/);
assert.deepEqual(authorized.calls[1][1].allowedMentions,{parse:[]});
assert.equal(queries,3);
console.log('review command access tests passed');
