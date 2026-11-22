// Only an explicitly registered giveaway message can unlock the next cycle.
// Unknown layouts, missing content or unreadable channels must remain pending.
export function isConfirmedBoatResult(message, { messageId, channelId, boatId }) {
  if (!message || message.id !== messageId || (message.channelId ?? message.channel_id) !== channelId || message.author?.id !== boatId) return false;
  if (message.content !== '🎊 **GIVEAWAY ENDED** 🎊') return false;
  const embed = message.embeds?.[0];
  if (embed?.footer?.text !== 'Ended at' || !Number.isFinite(Date.parse(embed.timestamp))) return false;
  const description = embed.description || '';
  if (!/^(?:Winner(?:s)?:\s*<@!?\d{17,20}>|No one entered the giveaway!)/.test(description)) return false;
  const buttons = (message.components || []).flatMap(row => row.components || []);
  return buttons.some(button => (button.customId ?? button.custom_id) === 'giveaway_message' && button.disabled === true);
}

export async function fetchConfirmedBoatResult(guild, registration, boatId) {
  const channel = await guild.channels.fetch(registration.channel_id);
  if (!channel || channel.guildId !== guild.id || !channel.messages) throw Error('DAILY_GIVEAWAY_CHANNEL_UNVERIFIED');
  const message = await channel.messages.fetch({ message: registration.message_id, force: true });
  return isConfirmedBoatResult(message, { messageId:registration.message_id, channelId:registration.channel_id, boatId });
}
