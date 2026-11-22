import assert from 'node:assert/strict';
import { ChannelType, Collection, MessageType } from 'discord.js';
import { scheduledSnapshot, scanSnapshotChannel, eligibleWithSnapshot, pruneSnapshots } from './message-snapshot.mjs';

const queries=[];
const retentionSql=(parts,...values)=>({text:parts.join('?'),values});
retentionSql.transaction=async items=>queries.push(items);
assert.equal(await pruneSnapshots(retentionSql,Date.parse('2027-01-01T15:59:59Z')),'2026-12-30'); // Jan 1, 23:59:59 Taiwan
assert.equal(await pruneSnapshots(retentionSql,Date.parse('2027-01-01T16:00:00Z')),'2026-12-31'); // Jan 2, 00:00 Taiwan
assert.equal(await pruneSnapshots(retentionSql,Date.parse('2028-03-01T00:00:00Z')),'2028-02-28');
assert.deepEqual(queries[0].map(q=>q.text.match(/daily_chat_snapshot_\w+/)[0]),['daily_chat_snapshot_counts','daily_chat_snapshot_messages','daily_chat_snapshot_cursors']);
assert.ok(queries[0].every(q=>q.values[0]==='2026-12-30'));
const failingSql=(...args)=>retentionSql(...args);
failingSql.transaction=async()=>{throw Error('db unavailable');};
await assert.rejects(pruneSnapshots(failingSql,Date.now()),/db unavailable/);
await assert.rejects(pruneSnapshots(retentionSql,NaN),/TIME_INVALID/);

assert.equal(scheduledSnapshot(Date.parse('2026-11-21T01:00:00Z')).day,'2026-11-20'); // Saturday 09:00
assert.equal(scheduledSnapshot(Date.parse('2026-11-21T01:59:59Z')).day,'2026-11-20');
assert.equal(scheduledSnapshot(Date.parse('2026-11-21T02:00:00Z')),null); // Saturday 10:00: no new activity
assert.equal(scheduledSnapshot(Date.parse('2026-11-22T02:00:00Z')),null); // Sunday
assert.equal(scheduledSnapshot(Date.parse('2026-11-23T02:00:00Z')).day,'2026-11-23'); // Monday 10:00
assert.equal(scheduledSnapshot(Date.parse('2026-11-21T00:59:59Z')),null);
assert.equal(scheduledSnapshot(Date.parse('2026-11-21T14:00:00Z')),null); // 22:00
assert.equal(scheduledSnapshot(Date.parse('2026-11-23T13:59:00Z')),null); // Monday 21:59
assert.equal(scheduledSnapshot(Date.parse('2026-11-23T13:00:30Z')).day,'2026-11-23'); // 21:00 job
const base=10000000000000000n;
const messages=Array.from({length:230},(_,i)=>({id:String(base+BigInt(i)),createdTimestamp:1000+i,type:MessageType.Default,author:{id:i%2?'u1':'u2',bot:false}})).reverse();
const channel={permissionsFor:()=>({has:()=>true}),messages:{fetch:async({before})=>{
  const filtered=before?messages.filter(m=>BigInt(m.id)<BigInt(before)):messages;
  return new Collection(filtered.slice(0,100).map(m=>[m.id,m]));
}}};
let r=await scanSnapshotChannel(channel,{member:{},start:1000,end:2000,afterId:String(base+29n)});
assert.equal(r.entries.length,200);
assert.equal(r.cursor,String(base+229n));
r=await scanSnapshotChannel(channel,{member:{},start:1000,end:1200,afterId:String(base+29n)});
assert.equal(r.entries.length,170);
assert.equal(r.cursor,String(base+199n));
await assert.rejects(scanSnapshotChannel({...channel,permissionsFor:()=>({has:()=>false})},{member:{},start:1000,end:2000}),/PERMISSIONS_MISSING/);
await assert.rejects(scanSnapshotChannel(channel,{member:{},start:1000,end:2000,maxPages:1}),/SCAN_INCOMPLETE/);
const all=Array.from({length:10},(_,i)=>({id:String(base+BigInt(i)),createdTimestamp:1100+i,type:MessageType.Default,author:{id:'u1',bot:false}}));
let visible=all.filter((_,i)=>i!==3);
const activeChannel={id:'channel',parentId:'category',type:ChannelType.GuildText,permissionsFor:()=>({has:()=>true}),messages:{fetch:async options=>{
  if(options.message){const m=visible.find(x=>x.id===options.message);if(!m)throw Object.assign(new Error('missing'),{code:10008});return m;}
  const items=options.before?visible.filter(m=>BigInt(m.id)<BigInt(options.before)):visible;
  return new Collection([...items].reverse().map(m=>[m.id,m]));
}}};
const fakeSql=async parts=>parts.join('?').includes('cursors')?[{message_id:all.at(-1).id}]:all.map(m=>({message_id:m.id}));
const args={guild:{members:{me:{}},channels:{fetch:async()=>new Collection([['channel',activeChannel]])}},sql:fakeSql,day:'2026-11-20',categoryId:'category',userId:'u1',start:1000,end:2000,required:10};
assert.equal(await eligibleWithSnapshot(args),false,'a deleted cached message must not qualify');
visible=[...visible,{id:String(base+10n),createdTimestamp:1200,type:MessageType.Default,author:{id:'u1',bot:false}}];
assert.equal(await eligibleWithSnapshot(args),true,'the new tail must be added exactly once');
const racingSql=async parts=>parts.join('?').includes('cursors')?[{message_id:all.at(-1).id}]:[...all.map(m=>({message_id:m.id})),{message_id:String(base+10n)}];
assert.equal(await eligibleWithSnapshot({...args,sql:racingSql,required:11}),false,'a concurrent refresh must not count a fresh message twice');
await assert.rejects(eligibleWithSnapshot({...args,guild:{...args.guild,channels:{fetch:async()=>new Collection([['channel',{...activeChannel,permissionsFor:()=>({has:()=>false})}]])}}}),/PERMISSIONS_MISSING/);
console.log('snapshot slot and pagination tests passed');
