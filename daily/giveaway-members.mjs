import {ChannelType, PermissionFlagsBits} from 'discord.js';
import {scanSnapshotChannel} from './message-snapshot.mjs';
import {dateKey,eventTimes,isActivityDay,reportTime} from './time.mjs';
import {fetchConfirmedBoatResult} from './giveaway-boat-result.mjs';
import {randomUUID} from 'node:crypto';
import {giveawayCountWindow} from './giveaway-count-window.mjs';
import {resetFixedGiveawayRole} from './giveaway-fixed-reset.mjs';
import {grantQualifiedAddOnly} from './giveaway-add-only.mjs';

const DAY=86_400_000;
const idPattern=/^\d{17,20}$/;

// Full-history metadata scan: no content, bot messages, webhooks or threads.
// A scan that cannot complete or access every relevant channel fails closed.
export async function qualifyingMembers({guild,categoryId,start,end,threshold=20,onlyChannelId=null}) {
  const all=await guild.channels.fetch();
  const channels=[...all.values()].filter(c=>c?.parentId===categoryId && c.type===ChannelType.GuildText && (!onlyChannelId || c.id===onlyChannelId));
  if(!channels.length) throw Error('DAILY_GROUP_CHANNELS_MISSING');
  for(const channel of channels) if(!channel.permissionsFor(guild.members.me)?.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.ReadMessageHistory])) throw Error('DAILY_GROUP_PERMISSIONS_MISSING');
  const counts=new Map();
  for(const channel of channels) {
    const scan=await scanSnapshotChannel(channel,{member:guild.members.me,start,end});
    for(const entry of scan.entries) counts.set(entry.user_id,(counts.get(entry.user_id)||0)+1);
  }
  return [...counts].filter(([,count])=>count>=threshold).map(([userId])=>userId);
}

// Disabled unless explicitly configured. Rollover only touches recorded grants
// after each registered old draw is confirmed; no member enumeration intent.
export function createMemberGiveawayQualification({guildId,roleId,boatId,channelId,categoryId,client,sql,now=Date.now,onlyChannelId=null,unverifiedRoleId=null,collect=qualifyingMembers,fixedResetFrom=process.env.DAILY_GIVEAWAY_PERSIST_SAFE_START_DAY}) {
  if (![guildId,roleId,boatId,channelId,categoryId].every(v=>idPattern.test(v||'')) || (unverifiedRoleId && !idPattern.test(unverifiedRoleId))) throw Error('DAILY_GIVEAWAY_CONFIGURATION_INVALID');
  if(fixedResetFrom && onlyChannelId) throw Error('DAILY_GIVEAWAY_FIXED_RESET_PRIVATE_TEST_REQUIRES_ISOLATION');
  let running=false;
  const resetOwner=randomUUID();
  async function initialize() {
    // Retain legacy rows for audit; production grants have a separate ledger.
    await sql`CREATE TABLE IF NOT EXISTS daily_giveaway_role_grants (user_id text PRIMARY KEY, activity_day text NOT NULL)`;
    await sql`CREATE TABLE IF NOT EXISTS daily_giveaway_legacy_test_grants (user_id text NOT NULL, activity_day text NOT NULL, test_role_id text NOT NULL, test_channel_id text NOT NULL, evidence text NOT NULL, classified_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id,activity_day))`;
    await sql`CREATE TABLE IF NOT EXISTS daily_giveaway_member_role_grants (user_id text PRIMARY KEY, activity_day text NOT NULL)`;
    await sql`CREATE TABLE IF NOT EXISTS daily_giveaway_sessions (day text PRIMARY KEY, channel_id text NOT NULL, message_id text NOT NULL UNIQUE)`;
    await sql`CREATE TABLE IF NOT EXISTS daily_disqualifications (day text NOT NULL, kind text NOT NULL, user_id text NOT NULL, moderator_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(day,kind,user_id))`;
    if(fixedResetFrom) await sql`CREATE TABLE IF NOT EXISTS daily_giveaway_fixed_role_resets (day text PRIMARY KEY, owner_id text NOT NULL, completed_at timestamptz)`;
  }
  async function tick() {
    if(running) return;
    running=true;
    try {
      const time=now();
      if(fixedResetFrom) {
        const guild=await client.guilds.fetch(guildId);
        const reset=await resetFixedGiveawayRole({guild,sql,roleId,enabledFrom:fixedResetFrom,ownerId:resetOwner,now});
        if(reset.active) {
          const window=giveawayCountWindow(time);
          if(!window) return;
          const currentGrants=await sql`SELECT user_id,activity_day FROM daily_giveaway_member_role_grants WHERE activity_day=${window.day}`;
          for(const row of currentGrants) {
            const [cancelled]=await sql`SELECT 1 FROM daily_disqualifications WHERE day=${window.day} AND kind='giveaway' AND user_id=${row.user_id}`;
            if(!cancelled && !unverifiedRoleId) continue;
            let member;
            try {member=await guild.members.fetch({user:row.user_id,force:true});}
            catch(error) {if(error.code!==10007) throw error;}
            if(member && !member.roles?.cache) throw Error('DAILY_GIVEAWAY_MEMBER_ROLES_UNAVAILABLE');
            if(member?.roles.cache.has(roleId) && (cancelled || (unverifiedRoleId && member.roles.cache.has(unverifiedRoleId)))) await member.roles.remove(roleId,cancelled ? 'Moderator cancelled giveaway eligibility' : 'Member is not verified');
          }
          return await grantQualifiedAddOnly({guild,sql,roleId,categoryId,unverifiedRoleId,onlyChannelId,now,collect});
        }
      }
      const day=[dateKey(time-DAY),dateKey(time)].find(d=>isActivityDay(d)&&time>=eventTimes(d,'giveaway').start&&time<eventTimes(d,'giveaway').end);
      const unclassified=await sql`SELECT g.user_id,g.activity_day FROM daily_giveaway_role_grants g LEFT JOIN daily_giveaway_legacy_test_grants t ON t.user_id=g.user_id AND t.activity_day=g.activity_day AND t.test_role_id<>${roleId} AND t.test_channel_id<>${channelId} AND length(btrim(t.evidence))>0 WHERE t.user_id IS NULL ORDER BY g.activity_day,g.user_id`;
      if(unclassified.length) throw Error('DAILY_GIVEAWAY_LEGACY_GRANTS_UNCLASSIFIED');
      const grants=await sql`SELECT user_id,activity_day FROM daily_giveaway_member_role_grants ORDER BY activity_day,user_id`;
      const old=grants.filter(row=>row.activity_day!==day && time>=reportTime(row.activity_day,'giveaway'));
      if(!day&&!old.length) return;
      const guild=await client.guilds.fetch(guildId);
      const role=await guild.roles.fetch(roleId);
      if(!role||!guild.members.me?.permissions.has(PermissionFlagsBits.ManageRoles)||role.position>=guild.members.me.roles.highest.position) throw Error('DAILY_GIVEAWAY_ROLE_NOT_MANAGEABLE');
      for(const oldDay of new Set(old.map(x=>x.activity_day))) {
        const [session]=await sql`SELECT channel_id,message_id FROM daily_giveaway_sessions WHERE day=${oldDay}`;
        if(!session||session.channel_id!==channelId||!await fetchConfirmedBoatResult(guild,session,boatId)) throw Error('DAILY_GIVEAWAY_PRIOR_DRAW_UNCONFIRMED');
      }
      for(const row of old) {
        let member;
        try {member=await guild.members.fetch({user:row.user_id,force:true});}
        catch(error) {if(error.code!==10007) throw error;}
        if(member?.roles.cache.has(roleId)) await member.roles.remove(roleId,'Previous registered Giveaway Boat draw confirmed');
        await sql`DELETE FROM daily_giveaway_member_role_grants WHERE user_id=${row.user_id} AND activity_day=${row.activity_day}`;
      }
      if(!day) return;
      // Reconcile a cancellation whose Discord role removal failed, even if
      // the member no longer appears in the current message scan.
      for(const row of grants.filter(row=>row.activity_day===day)) {
        const [cancelled]=await sql`SELECT 1 FROM daily_disqualifications WHERE day=${day} AND kind='giveaway' AND user_id=${row.user_id}`;
        if(!cancelled && !unverifiedRoleId) continue;
        let member;
        try { member=await guild.members.fetch({user:row.user_id,force:true}); }
        catch(error) { if(error.code!==10007) throw error; }
        if (member && !member.roles?.cache) throw Error('DAILY_GIVEAWAY_MEMBER_ROLES_UNAVAILABLE');
        if(member?.roles.cache.has(roleId) && (cancelled || (unverifiedRoleId && member.roles.cache.has(unverifiedRoleId)))) await member.roles.remove(roleId,cancelled ? 'Moderator cancelled giveaway eligibility' : 'Member is not verified');
      }
      // Today's message-count eligibility is independent of whether the
      // giveaway has been created. Previous grants still require a confirmed
      // draw before removal in the rollover logic above.
      const {start,end}=eventTimes(day,'giveaway');
      const members=await collect({guild,categoryId,start,end:Math.min(time+1,end),onlyChannelId});
      for(const userId of members) {
        if(!idPattern.test(userId)) throw Error('DAILY_GIVEAWAY_MEMBER_ID_INVALID');
        if(now()>=end) break;
        const [cancelled]=await sql`SELECT 1 FROM daily_disqualifications WHERE day=${day} AND kind='giveaway' AND user_id=${userId}`;
        if(cancelled) continue;
        const member=await guild.members.fetch({user:userId,force:true});
        if (!member.roles?.cache) throw Error('DAILY_GIVEAWAY_MEMBER_ROLES_UNAVAILABLE');
        if(member.user.bot || !member.manageable || (unverifiedRoleId && member.roles.cache.has(unverifiedRoleId))) continue;
        const [grant]=await sql`SELECT activity_day FROM daily_giveaway_member_role_grants WHERE user_id=${userId}`;
        if(member.roles.cache.has(roleId)) {
          if(!grant || grant.activity_day!==day) throw Error('DAILY_GIVEAWAY_UNTRACKED_ROLE');
          continue;
        }
        await sql`INSERT INTO daily_giveaway_member_role_grants(user_id,activity_day) VALUES (${userId},${day}) ON CONFLICT(user_id) DO UPDATE SET activity_day=excluded.activity_day`;
        await member.roles.add(roleId,'Qualified for daily giveaway');
      }
    } finally {running=false;}
  }
  return {initialize,tick};
}
