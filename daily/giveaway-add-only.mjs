import {PermissionFlagsBits} from 'discord.js';
import {giveawayCountWindow} from './giveaway-count-window.mjs';

// Repair an in-progress day's grants without touching any existing role or
// giveaway entry. A complete channel scan is required before any mutation.
export async function grantQualifiedAddOnly({guild,sql,roleId,categoryId,unverifiedRoleId=null,onlyChannelId=null,now=Date.now,collect,recordGrant=null}) {
  if(typeof collect!=='function') throw Error('DAILY_GIVEAWAY_SCANNER_REQUIRED');
  const timestamp=now(), window=giveawayCountWindow(timestamp);
  if(!window) throw Error('DAILY_GIVEAWAY_OUTSIDE_ACTIVE_WINDOW');
  const {day,start,end}=window;
  const role=await guild.roles.fetch(roleId);
  if(!role || !guild.members.me?.permissions.has(PermissionFlagsBits.ManageRoles) || role.position>=guild.members.me.roles.highest.position) throw Error('DAILY_GIVEAWAY_ROLE_NOT_MANAGEABLE');
  const userIds=await collect({guild,categoryId,start,end:Math.min(timestamp+1,end),onlyChannelId});
  const results={day,scannedAt:new Date(timestamp).toISOString(),qualified:userIds.length,added:0,alreadyPresent:0,skipped:0};
  for(const userId of new Set(userIds)) {
    if(!/^\d{17,20}$/.test(userId)) throw Error('DAILY_GIVEAWAY_MEMBER_ID_INVALID');
    if(now()>=end) throw Error('DAILY_GIVEAWAY_WINDOW_ENDED_DURING_GRANTS');
    const [cancelled]=await sql`SELECT 1 FROM daily_disqualifications WHERE day=${day} AND kind='giveaway' AND user_id=${userId}`;
    if(cancelled){results.skipped++;continue;}
    let member;
    try { member=await guild.members.fetch({user:userId,force:true}); }
    catch(error) { if(error.code===10007){results.skipped++;continue;} throw error; }
    if(!member.roles?.cache) throw Error('DAILY_GIVEAWAY_MEMBER_ROLES_UNAVAILABLE');
    if(member.user.bot || !member.manageable || (unverifiedRoleId && member.roles.cache.has(unverifiedRoleId))){results.skipped++;continue;}
    if(member.roles.cache.has(roleId)){results.alreadyPresent++;continue;}
    // Record first: if Discord fails, the next run can retry the idempotent add.
    if(recordGrant) await recordGrant({userId,day,roleId});
    else await sql`INSERT INTO daily_giveaway_member_role_grants(user_id,activity_day) VALUES (${userId},${day}) ON CONFLICT(user_id) DO UPDATE SET activity_day=excluded.activity_day`;
    await member.roles.add(roleId,'Daily giveaway message threshold reached');
    results.added++;
  }
  return results;
}
