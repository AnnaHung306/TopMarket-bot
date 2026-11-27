import {PermissionFlagsBits} from 'discord.js';
import {dateKey,midnight} from './time.mjs';

const DAY=86400000;
const validDate=day=>/^\d{4}-\d{2}-\d{2}$/.test(day||'') && Number.isFinite(midnight(day)) && dateKey(midnight(day))===day;

export function giveawayResetDay(now) {
  if(!Number.isFinite(now)) throw Error('DAILY_GIVEAWAY_TIME_INVALID');
  const today=dateKey(now);
  return now>=midnight(today)+9*3600000 ? today : dateKey(midnight(today)-DAY);
}

// The activation date is an operator attestation that every giveaway using
// this role has protected its entries. This function never reads giveaway
// state and never creates roles. Interrupted resets are retried before grants.
export async function resetFixedGiveawayRole({guild,sql,roleId,enabledFrom,ownerId,now=Date.now}) {
  if(!validDate(enabledFrom)) throw Error('DAILY_GIVEAWAY_PERSISTENCE_START_REQUIRED');
  if(!/^[a-f0-9-]{36}$/i.test(ownerId||'')) throw Error('DAILY_GIVEAWAY_RESET_OWNER_INVALID');
  const day=giveawayResetDay(now());
  if(day<enabledFrom) return {day,active:false};
  const [existing]=await sql`SELECT owner_id,completed_at FROM daily_giveaway_fixed_role_resets WHERE day=${day}`;
  if(existing?.completed_at) return {day,active:true,alreadyComplete:true};
  if(existing && existing.owner_id!==ownerId) throw Error('DAILY_GIVEAWAY_RESET_NEEDS_REVIEW');
  const role=await guild.roles.fetch(roleId);
  if(!role || !guild.members.me?.permissions.has(PermissionFlagsBits.ManageRoles) || role.position>=guild.members.me.roles.highest.position) throw Error('DAILY_GIVEAWAY_ROLE_NOT_MANAGEABLE');
  const all=await guild.members.fetch({time:60000});
  const current=await guild.fetch();
  if(!Number.isInteger(current.memberCount) || all.size!==current.memberCount) throw Error('DAILY_GIVEAWAY_MEMBER_INVENTORY_INCOMPLETE');
  if([...all.values()].some(member=>!member.roles?.cache)) throw Error('DAILY_GIVEAWAY_MEMBER_ROLES_UNAVAILABLE');
  const holders=[...all.values()].filter(member=>member.roles?.cache?.has(roleId));
  if(holders.some(member=>!member.manageable)) throw Error('DAILY_GIVEAWAY_ROLE_HOLDER_NOT_MANAGEABLE');
  const [claim]=await sql`INSERT INTO daily_giveaway_fixed_role_resets(day,owner_id) VALUES (${day},${ownerId}) ON CONFLICT(day) DO UPDATE SET owner_id=excluded.owner_id WHERE daily_giveaway_fixed_role_resets.owner_id=excluded.owner_id AND daily_giveaway_fixed_role_resets.completed_at IS NULL RETURNING owner_id`;
  if(!claim) throw Error('DAILY_GIVEAWAY_RESET_NEEDS_REVIEW');
  for(const member of holders) await member.roles.remove(roleId,'Daily giveaway qualification reset');
  await sql`UPDATE daily_giveaway_fixed_role_resets SET completed_at=now() WHERE day=${day} AND owner_id=${ownerId} AND completed_at IS NULL`;
  return {day,active:true,removed:holders.length};
}
