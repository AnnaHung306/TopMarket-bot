import { PermissionFlagsBits } from 'discord.js';
import { splitLinks } from './discord-link-check.mjs';
import { MOD_CHANNEL } from './discord-channel-scope.mjs';

const GUILD = '1541304826674155550';
const CHINESE = '1548950663008878683';
const MOD = '1571738627460038736';

// Off by default; trial mode only inspects the existing private MOD channel.
export async function isRestrictedVerifiedLink(message, mode = 'off') {
  const channel = mode === 'trial' ? MOD_CHANNEL : mode === 'chinese' ? CHINESE : null;
  if (!channel || message.guildId !== GUILD || message.channelId !== channel || message.author?.bot || message.webhookId) return false;
  if (!splitLinks(message.content.normalize('NFKC')).hosts.length) return false;
  let member = message.member;
  if (!member) {
    try { member = await message.guild.members.fetch(message.author.id); }
    catch (error) { console.error('Verified link member lookup failed:', error.code ?? error.message); return false; }
  }
  return !member.roles.cache.has(MOD) && !member.permissions?.has(PermissionFlagsBits.Administrator);
}
