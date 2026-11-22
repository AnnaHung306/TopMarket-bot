import { PermissionFlagsBits } from 'discord.js';
import { dateKey, eventTimes, isActivityDay, reportTime } from './time.mjs';
import { hasMessages } from './eligibility.mjs';
import { fetchConfirmedBoatResult } from './giveaway-boat-result.mjs';

const DAY = 86_400_000;

// The role bridge is deliberately restricted to one named tester until the
// real Giveaway Boat flow and role-removal behavior have been accepted.
export function createGiveawayQualification({ guildId, roleId, testerId, boatId, testChannelId, channelIds, categoryId, client, sql, now = Date.now, checkEligibility = hasMessages }) {
  for (const value of [guildId, roleId, testerId, boatId, testChannelId]) if (!/^\d{17,20}$/.test(value || '')) throw Error('DAILY_GIVEAWAY_TEST_CONFIGURATION_INVALID');
  let running = false;
  async function initialize() {
    await sql`CREATE TABLE IF NOT EXISTS daily_giveaway_role_grants (user_id text PRIMARY KEY, activity_day text NOT NULL)`;
    await sql`CREATE TABLE IF NOT EXISTS daily_disqualifications (day text NOT NULL, kind text NOT NULL, user_id text NOT NULL, moderator_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(day,kind,user_id))`;
    await sql`CREATE TABLE IF NOT EXISTS daily_giveaway_sessions (day text PRIMARY KEY, channel_id text NOT NULL, message_id text NOT NULL UNIQUE)`;
    await sql`ALTER TABLE daily_giveaway_sessions ADD COLUMN IF NOT EXISTS participant_report_message_id text`;
  }
  async function tick() {
    if (running) return;
    running = true;
    try {
      const time = now();
      const day = [dateKey(time - DAY), dateKey(time)].find(d => {
        const {start,end} = eventTimes(d,'giveaway');
        return isActivityDay(d) && time >= start && time < end;
      });
      const previous = await sql`SELECT user_id, activity_day FROM daily_giveaway_role_grants WHERE user_id=${testerId}`;
      const shouldReset = previous.length && previous[0].activity_day !== day && time >= reportTime(previous[0].activity_day,'giveaway');
      if (!day && !shouldReset) return;
      const guild = await client.guilds.fetch(guildId);
      const role = await guild.roles.fetch(roleId);
      if (!role || !guild.members.me?.permissions.has(PermissionFlagsBits.ManageRoles) || role.position >= guild.members.me.roles.highest.position) throw Error('DAILY_GIVEAWAY_ROLE_NOT_MANAGEABLE');
      const member = await guild.members.fetch(testerId);
      if (shouldReset) {
        const [registration] = await sql`SELECT channel_id,message_id FROM daily_giveaway_sessions WHERE day=${previous[0].activity_day}`;
        if (!registration || registration.channel_id !== testChannelId || !await fetchConfirmedBoatResult(guild,registration,boatId)) throw Error('DAILY_GIVEAWAY_PRIOR_DRAW_UNCONFIRMED');
        await member.roles.remove(roleId, 'Previous registered Giveaway Boat result confirmed');
        await sql`DELETE FROM daily_giveaway_role_grants WHERE user_id=${testerId} AND activity_day=${previous[0].activity_day}`;
      }
      if (!day) return;
      // A moderator decision must override message counts; otherwise the next
      // reconciliation would silently re-grant a removed role.
      const disqualified = await sql`SELECT 1 FROM daily_disqualifications WHERE day=${day} AND kind='giveaway' AND user_id=${testerId}`;
      if (disqualified.length) {
        if (member.roles.cache.has(roleId)) await member.roles.remove(roleId, 'Moderator cancelled giveaway eligibility');
        return;
      }
      if (previous.length && previous[0].activity_day === day && member.roles.cache.has(roleId)) return;
      const {start,end} = eventTimes(day,'giveaway');
      if (!await checkEligibility({guild,channelIds,categoryId,userId:testerId,start,end:Math.min(time,end-1),required:20})) return;
      if (now() >= end) return;
      // Record first so a crash after the Discord update can be reconciled.
      await sql`INSERT INTO daily_giveaway_role_grants(user_id,activity_day) VALUES (${testerId},${day}) ON CONFLICT(user_id) DO UPDATE SET activity_day=excluded.activity_day`;
      await member.roles.add(roleId, 'Qualified for daily giveaway');
    } finally { running = false; }
  }
  return {initialize,tick};
}
