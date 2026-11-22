// Discord command visibility is not authorization: every operation must also
// validate the real member's moderator role and the private channel server-side.
export function mayManageActivity(interaction, { guildId, modChannelId, moderatorRoleId }) {
  return interaction?.guildId === guildId
    && interaction?.channelId === modChannelId
    && interaction?.member?.roles?.cache?.has(moderatorRoleId) === true;
}
import { SlashCommandBuilder } from 'discord.js';


// Registered only in the isolated single-tester mode pending acceptance.
export const cancelCommand = new SlashCommandBuilder()
  .setName('cancel')
  .setDescription('取消成員指定活動本場資格（僅 MOD）')
  .setDefaultMemberPermissions(0)
  .addStringOption(option => option.setName('activity').setDescription('選擇要取消資格的活動').setRequired(true)
    .addChoices({name:'每日答題', value:'quiz'}, {name:'Giveaway', value:'giveaway'}))
  .addUserOption(option => option.setName('user').setDescription('要取消資格的成員').setRequired(true));
