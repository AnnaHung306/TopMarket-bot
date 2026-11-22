import { PermissionFlagsBits } from 'discord.js';

const GUILD = '1541304826674155550';
export const MOD_CHANNEL = '1572821315507855430';
const COMMUNITY_CHANNELS = new Set(['1541307245311164496', '1548950663008878683']);
const COMMUNITY_START = Date.parse('2026-11-23T09:00:00+08:00');

// Public monitoring requires both explicit configuration and the agreed time.
export function createChannelScope({ communityEnabled = false, now = Date.now } = {}) {
  return message => message.guildId === GUILD && (
    message.channelId === MOD_CHANNEL ||
    (communityEnabled && now() >= COMMUNITY_START && COMMUNITY_CHANNELS.has(message.channelId))
  );
}

export async function moderatorChannel(message) {
  if (message.channelId === MOD_CHANNEL) return message.channel;
  const channel = await message.guild?.channels.fetch(MOD_CHANNEL);
  if (!channel?.send || channel.id !== MOD_CHANNEL || channel.guildId !== GUILD) throw Error('MOD_CHANNEL_UNAVAILABLE');
  const permissions = channel.permissionsFor(message.guild.members.me);
  if (!permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) throw Error('MOD_CHANNEL_PERMISSION_MISSING');
  return channel;
}
