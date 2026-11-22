import { mayManageActivity } from './moderator-access.mjs';
import { dateKey, eventTimes, isActivityDay } from './time.mjs';

const DAY=86400000;
const snowflake=/^\d{17,20}$/;

export async function recordCancellation({ interaction, settings, targetId, activity, sql, now=Date.now }) {
  if (!mayManageActivity(interaction,settings)) throw Error('DAILY_MODERATOR_REQUIRED');
  if (!snowflake.test(targetId || '') || !snowflake.test(interaction.user?.id || '')) throw Error('DAILY_CANCEL_USER_INVALID');
  if (!['quiz','giveaway'].includes(activity)) throw Error('DAILY_CANCEL_ACTIVITY_INVALID');
  const time=now();
  const day=[dateKey(time-DAY),dateKey(time)].find(d=>isActivityDay(d) && time>=eventTimes(d,activity).start && time<eventTimes(d,activity).end);
  if (!day) throw Error('DAILY_CANCEL_NO_ACTIVE_ACTIVITY');
  // Record only the selected activity and its start date. Persist the decision
  // before any external role update to prevent re-grant.
  const [row]=await sql`WITH recorded AS (
    INSERT INTO daily_disqualifications(day,kind,user_id,moderator_id)
    VALUES (${day},${activity},${targetId},${interaction.user.id})
    ON CONFLICT(day,kind,user_id) DO NOTHING RETURNING kind
  ), removed AS (
    DELETE FROM daily_entries WHERE day=${day} AND kind='quiz' AND ${activity}='quiz' AND user_id=${targetId} RETURNING user_id
  ) SELECT (SELECT count(*)::int FROM recorded) AS newly_recorded, (SELECT count(*)::int FROM removed) AS quiz_entries_removed`;
  return {day, activity, newlyRecorded:row.newly_recorded, quizEntriesRemoved:row.quiz_entries_removed, giveawayRemovalConfirmed:false};
}

// The Discord role operation is deliberately separate from the transaction:
// if Discord is unavailable, the disqualification persists and a retry is safe.
export async function removeGiveawayRole({ guild, roleId, targetId }) {
  const role = await guild.roles.fetch(roleId);
  const me = await guild.members.fetchMe();
  if (!role || !me.permissions.has('ManageRoles') || role.position >= me.roles.highest.position) throw Error('DAILY_CANCEL_ROLE_NOT_MANAGEABLE');
  const member = await guild.members.fetch(targetId);
  if (!member.manageable) throw Error('DAILY_CANCEL_MEMBER_NOT_MANAGEABLE');
  if (member.roles.cache.has(roleId)) await member.roles.remove(roleId, 'MOD cancelled daily activity eligibility');
  const updated = await guild.members.fetch({user:targetId,force:true});
  if (updated.roles.cache.has(roleId)) throw Error('DAILY_CANCEL_ROLE_STILL_PRESENT');
}
