import { ChannelType, MessageType, PermissionFlagsBits } from 'discord.js';

// Rebuild from history so a restart cannot silently drop qualifying messages.
export async function hasMessages({ guild, channelIds, categoryId, userId, start, end, required }) {
  let count = 0;
  const channels = [];
  for (const id of channelIds) {
    const channel = await guild.channels.fetch(id);
    if (!channel || channel.parentId !== categoryId || channel.type !== ChannelType.GuildText) throw Error('DAILY_GROUP_CHANNELS_MISSING');
    if (!channel.permissionsFor(guild.members.me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory])) throw Error('DAILY_GROUP_PERMISSIONS_MISSING');
    channels.push(channel);
  }
  for (const channel of channels) {
    let before;
    for (;;) {
      const page = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
      if (!page.size) break;
      let oldest = Infinity;
      for (const m of page.values()) {
        oldest = Math.min(oldest, m.createdTimestamp);
        if ([MessageType.Default, MessageType.Reply].includes(m.type) && m.createdTimestamp >= start && m.createdTimestamp <= end && m.author.id === userId && !m.author.bot && !m.webhookId) count++;
      }
      if (count >= required) return true;
      if (oldest < start || page.size < 100) break;
      before = page.last().id;
    }
  }
  return false;
}
