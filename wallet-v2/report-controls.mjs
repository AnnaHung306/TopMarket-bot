import { ActionRowBuilder, ButtonBuilder, ButtonStyle, SlashCommandBuilder, StringSelectMenuBuilder } from 'discord.js';

export const controlId = (id, action, revision) => `wv2:${id}:${revision ? revision + ':' : ''}${action}`;
const periods = [['all', '全期間'], ['7d', '近 7 天'], ['30d', '近 30 天'], ['month', '本月'], ['custom', '自訂日期']];
export const walletV2Command = new SlashCommandBuilder().setName('wallet').setDescription('查詢 Top.Market 錢包報告與卡牌升級')
  .addStringOption(option => option.setName('address').setDescription('Base 錢包地址').setRequired(true))
  .addStringOption(option => option.setName('period').setDescription('時間範圍').addChoices(...periods.map(([value, name]) => ({ name, value }))))
  .addStringOption(option => option.setName('from').setDescription('自訂起日 YYYY-MM-DD，台灣時間'))
  .addStringOption(option => option.setName('to').setDescription('自訂迄日 YYYY-MM-DD，台灣時間'));

// Public reports always include all activities. Older views retain their dates.
export function reportSelection(selection = {}) {
  return { ...selection, scope: 'all', poolId: null, dimension: 'location',
    period: selection.period || 'all', detail: selection.detail === 'detail' ? 'detail' : 'summary' };
}
export function viewComponents(_ledger, view) {
  const button = (action, label, emoji, style = ButtonStyle.Secondary) => new ButtonBuilder()
    .setCustomId(controlId(view.id, action, view.revision)).setLabel(label).setEmoji(emoji).setStyle(style);
  return [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
    .setCustomId(controlId(view.id, 'period', view.revision)).setPlaceholder('選擇期間')
    .addOptions(periods.map(([value, label]) => ({ label, value, emoji: { name: '🗓️' }, default: value === view.selection.period })))),
  new ActionRowBuilder().addComponents(
    button('detail', view.selection.detail === 'summary' ? '詳細報表' : '收合明細', view.selection.detail === 'summary' ? '📋' : '🔽'),
    button('png', '下載 PNG', '🖼️').setDisabled(view.phase === 'draft'),
    button('csv', '匯出 CSV', '📄').setDisabled(view.phase === 'draft'),
    button('refresh', '更新資料', '🔄', ButtonStyle.Primary))];
}
