import assert from 'node:assert/strict';
import {resetFixedGiveawayRole,giveawayResetDay} from './giveaway-fixed-reset.mjs';
import {eventTimes} from './time.mjs';

const roleId='10000000000000001',ownerId='11111111-1111-1111-1111-111111111111',otherOwner='22222222-2222-2222-2222-222222222222';
const round=eventTimes('2026-11-27','giveaway');
assert.equal(giveawayResetDay(round.end-1),'2026-11-27');
assert.equal(giveawayResetDay(round.end),'2026-11-28');
let time=round.end, row, removes=0, size=2, memberCount=2;
const members=[{manageable:true,roles:{cache:{has:id=>id===roleId},remove:async()=>{removes++;}}},{manageable:true,roles:{cache:{has:()=>false}}}];
const guild={roles:{fetch:async()=>({position:1})},members:{me:{permissions:{has:()=>true},roles:{highest:{position:2}}},fetch:async()=>({size,values:()=>members.values()})},fetch:async()=>({memberCount})};
const sql=async (parts,...values)=>{
  const q=parts.join('?');
  if(q.startsWith('SELECT owner_id')) return row?[row]:[];
  if(q.startsWith('INSERT INTO daily_giveaway_fixed_role_resets')) {
    if(row && row.owner_id!==values[1]) return [];
    row={owner_id:values[1],completed_at:null};return [{owner_id:values[1]}];
  }
  if(q.startsWith('UPDATE daily_giveaway_fixed_role_resets')) {row.completed_at='done';return [];}
  throw Error(q);
};
const args={guild,sql,roleId,enabledFrom:'2026-11-28',ownerId,now:()=>time};
assert.deepEqual(await resetFixedGiveawayRole(args),{day:'2026-11-28',active:true,removed:1});
await resetFixedGiveawayRole(args);assert.equal(removes,1,'never reset twice after new grants');
row=undefined;size=1;
await assert.rejects(resetFixedGiveawayRole(args),/INVENTORY_INCOMPLETE/);
assert.equal(removes,1,'incomplete member list must not remove any role');
size=2;members[0].manageable=false;
await assert.rejects(resetFixedGiveawayRole(args),/HOLDER_NOT_MANAGEABLE/);
assert.equal(removes,1,'unmanageable holder blocks before any removal');
members[0].manageable=true;row={owner_id:otherOwner,completed_at:null};
await assert.rejects(resetFixedGiveawayRole(args),/RESET_NEEDS_REVIEW/);
assert.equal(removes,1,'another instance pending reset cannot race');
time=round.end-1;row=undefined;
assert.deepEqual(await resetFixedGiveawayRole(args),{day:'2026-11-27',active:false});
assert.equal(removes,1,'activation date protects the existing activity');
console.log('fixed-role reset, isolation and activation tests passed');
