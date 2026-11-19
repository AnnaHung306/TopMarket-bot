import { PermissionFlagsBits } from 'discord.js';
import { dateKey, eventTimes, isActivityDay } from './time.mjs';
import { hasMessages } from './eligibility.mjs';

const DAY = 86_400_000;

// The role bridge is deliberately restricted to one named tester until the
// real Giveaway Boat flow and role-removal behavior have been accepted.
export function createGiveawayQualification({ guildId, roleId, testerId, channelIds, categoryId, client, sql, now = Date.now }) {
  for (const value of [guildId, roleId, testerId]) if (!/^\d{17,20}$/.test(value || '')) throw Error('DAILY_GIVEAWAY_TEST_CONFIGURATION_INVALID');
  let running = false;
  async function initialize() {
    await sql`CREATE TABLE IF NOT EXISTS daily_giveaway_role_grants (user_id text PRIMARY KEY, activity_day text NOT NULL)`;
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
      if (!day) return;
      const guild = await client.guilds.fetch(guildId);
      const role = await guild.roles.fetch(roleId);
      if (!role || !guild.members.me?.permissions.has(PermissionFlagsBits.ManageRoles) || role.position >= guild.members.me.roles.highest.position) throw Error('DAILY_GIVEAWAY_ROLE_NOT_MANAGEABLE');
      const previous = await sql`SELECT user_id, activity_day FROM daily_giveaway_role_grants WHERE user_id=${testerId}`;
      const member = await guild.members.fetch(testerId);
      if (previous.length && previous[0].activity_day !== day) {
        await member.roles.remove(roleId, 'Clear prior activity eligibility');
        await sql`DELETE FROM daily_giveaway_role_grants WHERE user_id=${testerId} AND activity_day=${previous[0].activity_day}`;
      }
      if (previous.length && previous[0].activity_day === day && member.roles.cache.has(roleId)) return;
      const {start,end} = eventTimes(day,'giveaway');
      if (!await hasMessages({guild,channelIds,categoryId,userId:testerId,start,end:Math.min(time,end-1),required:20})) return;
      if (now() >= end) return;
      // Record first so a crash after the Discord update can be reconciled.
      await sql`INSERT INTO daily_giveaway_role_grants(user_id,activity_day) VALUES (${testerId},${day}) ON CONFLICT(user_id) DO UPDATE SET activity_day=excluded.activity_day`;
      await member.roles.add(roleId, 'Qualified for daily giveaway');
    } finally { running = false; }
  }
  return {initialize,tick};
}
