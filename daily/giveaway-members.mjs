import {ChannelType, PermissionFlagsBits} from 'discord.js';
import {scanSnapshotChannel} from './message-snapshot.mjs';
import {dateKey,eventTimes,isActivityDay,reportTime} from './time.mjs';
import {fetchConfirmedBoatResult} from './giveaway-boat-result.mjs';

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
export function createMemberGiveawayQualification({guildId,roleId,boatId,channelId,categoryId,client,sql,now=Date.now,onlyChannelId=null,collect=qualifyingMembers}) {
  if (![guildId,roleId,boatId,channelId,categoryId].every(v=>idPattern.test(v||''))) throw Error('DAILY_GIVEAWAY_CONFIGURATION_INVALID');
  let running=false;
  async function initialize() {
    await sql`CREATE TABLE IF NOT EXISTS daily_giveaway_role_grants (user_id text PRIMARY KEY, activity_day text NOT NULL)`;
    await sql`CREATE TABLE IF NOT EXISTS daily_giveaway_sessions (day text PRIMARY KEY, channel_id text NOT NULL, message_id text NOT NULL UNIQUE)`;
    await sql`CREATE TABLE IF NOT EXISTS daily_disqualifications (day text NOT NULL, kind text NOT NULL, user_id text NOT NULL, moderator_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(day,kind,user_id))`;
  }
  async function tick() {
    if(running) return;
    running=true;
    try {
      const time=now();
      const day=[dateKey(time-DAY),dateKey(time)].find(d=>isActivityDay(d)&&time>=eventTimes(d,'giveaway').start&&time<eventTimes(d,'giveaway').end);
      const grants=await sql`SELECT user_id,activity_day FROM daily_giveaway_role_grants ORDER BY activity_day,user_id`;
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
        await sql`DELETE FROM daily_giveaway_role_grants WHERE user_id=${row.user_id} AND activity_day=${row.activity_day}`;
      }
      if(!day) return;
      // Reconcile a cancellation whose Discord role removal failed, even if
      // the member no longer appears in the current message scan.
      for(const row of grants.filter(row=>row.activity_day===day)) {
        const [cancelled]=await sql`SELECT 1 FROM daily_disqualifications WHERE day=${day} AND kind='giveaway' AND user_id=${row.user_id}`;
        if(!cancelled) continue;
        let member;
        try { member=await guild.members.fetch({user:row.user_id,force:true}); }
        catch(error) { if(error.code!==10007) throw error; }
        if(member?.roles.cache.has(roleId)) await member.roles.remove(roleId,'Moderator cancelled giveaway eligibility');
      }
      const [currentSession]=await sql`SELECT channel_id,message_id FROM daily_giveaway_sessions WHERE day=${day}`;
      if(!currentSession || currentSession.channel_id!==channelId) throw Error('DAILY_GIVEAWAY_SESSION_UNREGISTERED');
      const activityChannel=await guild.channels.fetch(channelId);
      const message=await activityChannel?.messages.fetch({message:currentSession.message_id,force:true});
      const buttons=(message?.components||[]).flatMap(row=>row.components||[]);
      if(message?.id!==currentSession.message_id || message?.author?.id!==boatId || !buttons.some(button=>(button.customId??button.custom_id)==='giveaway_message' && button.disabled===false)) throw Error('DAILY_GIVEAWAY_SESSION_NOT_OPEN');
      const {start,end}=eventTimes(day,'giveaway');
      const members=await collect({guild,categoryId,start,end:Math.min(time+1,end),onlyChannelId});
      for(const userId of members) {
        if(!idPattern.test(userId)) throw Error('DAILY_GIVEAWAY_MEMBER_ID_INVALID');
        if(now()>=end) break;
        const [cancelled]=await sql`SELECT 1 FROM daily_disqualifications WHERE day=${day} AND kind='giveaway' AND user_id=${userId}`;
        if(cancelled) continue;
        const member=await guild.members.fetch({user:userId,force:true});
        if(member.user.bot || !member.manageable) continue;
        const [grant]=await sql`SELECT activity_day FROM daily_giveaway_role_grants WHERE user_id=${userId}`;
        if(member.roles.cache.has(roleId)) {
          if(!grant || grant.activity_day!==day) throw Error('DAILY_GIVEAWAY_UNTRACKED_ROLE');
          continue;
        }
        await sql`INSERT INTO daily_giveaway_role_grants(user_id,activity_day) VALUES (${userId},${day}) ON CONFLICT(user_id) DO UPDATE SET activity_day=excluded.activity_day`;
        await member.roles.add(roleId,'Qualified for daily giveaway');
      }
    } finally {running=false;}
  }
  return {initialize,tick};
}
