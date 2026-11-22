import assert from 'node:assert/strict';
import { quizParticipantIncidents, reviewPages } from './participant-review.mjs';

let captured;
const sql = () => [{user_id:'101'},{user_id:'102'}];
const incidentSql = (parts,...values) => { captured={query:parts.join('?'),values}; return [{user_id:'101',warnings:2,pending:1}]; };
const rows=await quizParticipantIncidents(sql,{guildId:'guild',day:'2026-11-20',start:0,end:1000,incidentSql});
assert.match(captured.query,/FROM discord_repeat_incidents/);
assert.deepEqual(captured.values,['guild',['101','102'],'1970-01-01T00:00:00.000Z','1970-01-01T00:00:01.000Z']);
assert.deepEqual(rows[1],{user_id:'102',warnings:0,pending:0});
await assert.rejects(quizParticipantIncidents(()=>[],{guildId:'guild',day:'2026-11-20',start:0,end:1000,incidentSql:()=>{throw Error('store unavailable');}}),/store unavailable/);
assert.match(reviewPages('2026-11-20',rows,1000)[0],/<@101>：2 次提示（1 次待審核）/);
assert.match(reviewPages('2026-11-20',[],1000)[0],/目前沒有參賽者/);
assert.ok(reviewPages('2026-11-20',Array.from({length:200},(_,i)=>({user_id:String(i),warnings:0,pending:0})),1000).every(page=>page.length<=1800));
console.log('participant review tests passed');
