import { SlashCommandBuilder } from 'discord.js';
import { dateKey, midnight } from './time.mjs';

const snowflake = /^\d{17,20}$/;

// Registration is restricted to the private testing channel by the caller.
// Never replace a day's existing binding: a changed ID needs investigation.
export const giveawayTrackCommand = new SlashCommandBuilder()
  .setName('giveaway-track').setDescription('登記私人測試的 Giveaway Boat 活動（僅 MOD）')
  .setDefaultMemberPermissions(0)
  .addStringOption(o => o.setName('date').setDescription('活動建立日期（台灣時間 YYYY-MM-DD）').setRequired(true))
  .addStringOption(o => o.setName('message-id').setDescription('Giveaway Boat 抽獎貼文的訊息 ID').setRequired(true));

export async function registerGiveaway({ guild, channelId, boatId, day, messageId, sql }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(midnight(day)) || dateKey(midnight(day)) !== day || !snowflake.test(messageId)) throw Error('DAILY_GIVEAWAY_REGISTRATION_INVALID');
  const channel = await guild.channels.fetch(channelId);
  if (!channel || channel.guildId !== guild.id || !channel.messages) throw Error('DAILY_GIVEAWAY_CHANNEL_UNVERIFIED');
  const message = await channel.messages.fetch({message:messageId,force:true});
  const components = (message.components || []).flatMap(row => row.components || []);
  if (message.id !== messageId || message.channelId !== channelId || message.author?.id !== boatId || !Number.isFinite(message.createdTimestamp) || dateKey(message.createdTimestamp) !== day || !components.some(button => (button.customId ?? button.custom_id) === 'giveaway_message')) throw Error('DAILY_GIVEAWAY_MESSAGE_UNVERIFIED');
  await sql`INSERT INTO daily_giveaway_sessions(day,channel_id,message_id) VALUES (${day},${channelId},${messageId}) ON CONFLICT DO NOTHING`;
  const [saved] = await sql`SELECT channel_id,message_id FROM daily_giveaway_sessions WHERE day=${day}`;
  if (!saved || saved.channel_id !== channelId || saved.message_id !== messageId) throw Error('DAILY_GIVEAWAY_REGISTRATION_CONFLICT');
  return saved;
}
