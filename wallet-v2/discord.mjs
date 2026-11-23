import { randomUUID, randomInt } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, ModalBuilder, SlashCommandBuilder,
  StringSelectMenuBuilder, TextInputBuilder, TextInputStyle, ThreadAutoArchiveDuration } from 'discord.js';
import { SCOPES, address, dateRange } from './model.mjs';
import { buildReport, textReport } from './report.mjs';
import { csvReport, renderPng } from './exports.mjs';
import { mayManageActivity } from '../daily/moderator-access.mjs';

// Exported definition only. Nothing in this module logs in, registers commands or changes the active bot.
export const walletV2Command = new SlashCommandBuilder().setName('wallet').setDescription('依活動、卡池與期間分析 Top.Market 錢包')
  .addStringOption(option => option.setName('address').setDescription('Base 錢包地址').setRequired(true))
  .addStringOption(option => option.setName('scope').setDescription('分析範圍；也可查完再切換').addChoices(
    ...Object.entries(SCOPES).map(([value, name]) => ({ name, value }))))
  .addStringOption(option => option.setName('pool').setDescription('指定活動池／卡池').setAutocomplete(true))
  .addStringOption(option => option.setName('period').setDescription('時間範圍').addChoices(
    { name: '全期間', value: 'all' }, { name: '近 7 天', value: '7d' }, { name: '近 30 天', value: '30d' },
    { name: '本月', value: 'month' }, { name: '自訂日期', value: 'custom' }))
  .addStringOption(option => option.setName('from').setDescription('自訂起日 YYYY-MM-DD，台灣時間'))
  .addStringOption(option => option.setName('to').setDescription('自訂迄日 YYYY-MM-DD，台灣時間'));

const customId = (id, action) => `wv2:${id}:${action}`;
function poolChoices(ledger, view) {
  const { scope, dimension } = view.selection;
  let pools = ledger.catalog.filter(pool => dimension === 'origin' ? pool.kind === 'packs'
    : scope === 'upgrade' ? pool.kind === 'upgrade' : ['packs', 'buyback'].includes(scope) ? pool.kind === 'packs' : true);
  if (view.search) pools = pools.filter(pool => `${pool.name} ${pool.id} ${pool.address}`.toLowerCase().includes(view.search.toLowerCase()));
  return pools;
}
export function viewComponents(ledger, view) {
  const pools = poolChoices(ledger, view), pages = Math.max(1, Math.ceil(pools.length / 23));
  const page = Math.max(0, Math.min(view.poolPage || 0, pages - 1));
  const pagePools = pools.slice(page * 23, (page + 1) * 23);
  const selected = ledger.catalog.find(pool => pool.id === view.selection.poolId);
  if (selected && !pagePools.some(pool => pool.id === selected.id)) pagePools.push(selected);
  const options = [{ label: '所有活動池／卡池', value: 'all', default: !selected },
    ...pagePools.map(pool => ({ label: pool.name.slice(0, 100), value: pool.id, default: pool.id === selected?.id,
      description: `${pool.enabled === false ? '已結束 · ' : ''}${pool.address}`.slice(0, 100) }))];
  const select = (action, placeholder, options) => new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
    .setCustomId(customId(view.id, action)).setPlaceholder(placeholder).addOptions(options));
  const button = (action, label, style = ButtonStyle.Secondary) => new ButtonBuilder().setCustomId(customId(view.id, action)).setLabel(label).setStyle(style);
  return [
    select('scope', '選擇分析範圍', Object.entries(SCOPES).map(([value, label]) => ({ label, value, default: value === view.selection.scope }))),
    select('pool', `活動池／卡池 ${page + 1}/${pages}`, options),
    select('period', '選擇期間', [['all', '全期間'], ['7d', '近 7 天'], ['30d', '近 30 天'], ['month', '本月'], ['custom', '自訂日期']]
      .map(([value, label]) => ({ label, value, default: value === view.selection.period }))),
    new ActionRowBuilder().addComponents(button('detail', ({ summary: '完整分析', analysis: '逐筆明細', detail: '簡要摘要' })[view.selection.detail]),
      button('png', '下載 PNG'), button('csv', '匯出 CSV'), button('refresh', '更新資料', ButtonStyle.Primary),
      button('dimension', view.selection.dimension === 'origin' ? '切到交易分類' : '依卡片來源')),
    new ActionRowBuilder().addComponents(button('search', '搜尋卡池'), button('clear-search', '清除搜尋'),
      button('previous', '上一頁卡池').setDisabled(page === 0), button('next', '下一頁卡池').setDisabled(page === pages - 1)),
  ];
}
function input(id, label, value = '') {
  const field = new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100);
  if (value) field.setValue(value);
  return new ActionRowBuilder().addComponents(field);
}
async function waitingGif() {
  const root = new URL('../assets/tenor-cat-wait/', import.meta.url);
  const files = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));
  const entry = files[randomInt(files.length)];
  if (!/^[a-z0-9-]+\.gif$/.test(entry.file)) throw Error('Invalid waiting image manifest');
  return { attachment: await readFile(new URL(entry.file, root)), name: 'cat-wait.gif' };
}
export function walletLocationAllowed(interaction, allowedChannel, policy = {}) {
  if (!allowedChannel) return false;
  const parent = interaction.channel?.isThread?.() ? interaction.channel.parentId : interaction.channelId;
  if (parent === allowedChannel) return true;
  const validPolicy = [policy.guildId, policy.modChannelId, policy.moderatorRoleId].every(value => /^\d{17,20}$/.test(value || ''));
  return validPolicy && mayManageActivity({ guildId: interaction.guildId, channelId: parent, member: interaction.member }, policy);
}
export function createV2InteractionHandler({ service, viewStore, renderPoster = renderPng,
  channelId = () => process.env.DISCORD_WALLET_CHANNEL_ID?.trim(), modPolicy = () => ({}), logger = console } = {}) {
  if (!service || !viewStore) throw Error('V2 service and persistent view store are required');
  const busy = new Set();
  const privateReply = (interaction, content) => interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  function permitted(interaction) {
    const allowed = typeof channelId === 'function' ? channelId() : channelId?.trim();
    return walletLocationAllowed(interaction, allowed, typeof modPolicy === 'function' ? modPolicy() : modPolicy);
  }
  async function payload(ledger, view) {
    const report = buildReport(ledger, view.selection);
    const started = performance.now();
    const png = await renderPoster(report);
    logger.info('wallet_v2_poster', JSON.stringify({ viewId: view.id, posterMs: Math.round(performance.now() - started), bytes: png.length }));
    return { content: textReport(report), components: viewComponents(ledger, view),
      files: [{ attachment: png, name: 'wallet-v2.png' }], attachments: [], allowedMentions: { parse: [] } };
  }
  return async interaction => {
    const command = interaction.isChatInputCommand?.() && interaction.commandName === 'wallet';
    const autocomplete = interaction.isAutocomplete?.() && interaction.commandName === 'wallet';
    const match = /^wv2:([a-f0-9]{32}):([a-z-]+)$/.exec(interaction.customId || '');
    if (!command && !autocomplete && !match) return;
    if (!permitted(interaction)) {
      if (autocomplete) return interaction.respond([]);
      return privateReply(interaction, '請在已設定的工具箱頻道或其討論串使用錢包分析。');
    }
    if (autocomplete) {
      const wallet = interaction.options.getString('address');
      if (!/^0x[\da-f]{40}$/i.test(wallet || '')) return interaction.respond([]);
      const ledger = await service.load(wallet);
      const query = String(interaction.options.getFocused()).toLowerCase();
      return interaction.respond(ledger.catalog.filter(pool => `${pool.name} ${pool.id}`.toLowerCase().includes(query))
        .slice(0, 25).map(pool => ({ name: pool.name.slice(0, 100), value: pool.id })));
    }
    let status, view, acquired = false;
    try {
      if (command) {
        const wallet = address(interaction.options.getString('address', true).trim());
        const selection = { scope: interaction.options.getString('scope') || 'all', poolId: interaction.options.getString('pool') || null,
          period: interaction.options.getString('period') || 'all', from: interaction.options.getString('from'),
          to: interaction.options.getString('to'), dimension: 'location', detail: 'summary' };
        if (!SCOPES[selection.scope]) throw Error('無效範圍');
        dateRange(selection);
        await interaction.deferReply();
        let thread = interaction.channel;
        if (!thread?.isThread?.()) {
          await interaction.editReply({ content: '貓貓正在核對錢包資料，完成後會在討論串通知。', files: [await waitingGif()] });
          const name = String(interaction.member?.displayName || interaction.user.username).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 70);
          thread = await interaction.channel.threads.create({ name: `${name} 錢包分析 V2`, autoArchiveDuration: ThreadAutoArchiveDuration.OneDay });
          await interaction.editReply({ content: `錢包分析進度與報告：<#${thread.id}>` });
        } else await interaction.editReply({ content: '正在核對錢包資料，報告會直接回覆在此討論串。' });
        status = await thread.send({ content: '正在核對所選活動與收支，請稍候。', allowedMentions: { parse: [] } });
        const { ledger } = await service.query(wallet, { scope: selection.scope });
        view = { id: randomUUID().replaceAll('-', ''), ownerId: interaction.user.id, wallet,
          channelId: thread.id, selection, poolPage: 0, createdAt: new Date().toISOString() };
        const response = await status.edit(await payload(ledger, view));
        view.messageId = response.id;
        await viewStore.saveView(view);
        return;
      }
      const [, id, action] = match;
      view = await viewStore.loadView(id);
      if (!view) return privateReply(interaction, '這份報告的操作資料無法讀取，請重新查詢。');
      if (view.ownerId !== interaction.user.id) return privateReply(interaction, '這是其他成員的報告；請使用 /wallet 建立自己的分析。');
      if (view.channelId !== interaction.channelId || view.messageId && interaction.message?.id !== view.messageId)
        return privateReply(interaction, '報告與目前討論串不相符，請回原報告操作。');
      if (busy.has(id)) return privateReply(interaction, '上一個操作正在完成，請稍候。');
      if (action === 'search') return interaction.showModal(new ModalBuilder().setCustomId(customId(id, 'search-submit'))
        .setTitle('搜尋活動池／卡池').addComponents(input('query', '名稱、活動 ID 或合約地址', view.search)));
      if (action === 'period' && interaction.values?.[0] === 'custom') return interaction.showModal(
        new ModalBuilder().setCustomId(customId(id, 'dates-submit')).setTitle('自訂日期（台灣時間）')
          .addComponents(input('from', '起日 YYYY-MM-DD', view.selection.from), input('to', '迄日 YYYY-MM-DD', view.selection.to)));
      if (['csv', 'png'].includes(action)) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const report = buildReport(await service.load(view.wallet), view.selection);
        const file = action === 'csv' ? Buffer.from(csvReport(report)) : await renderPoster(report);
        return interaction.editReply({ files: [{ attachment: file, name: `wallet-v2.${action}` }], allowedMentions: { parse: [] } });
      }
      busy.add(id);
      acquired = true;
      await interaction.deferUpdate();
      const next = { ...view, selection: { ...view.selection } };
      if (action === 'scope') { next.selection.scope = interaction.values[0]; next.selection.poolId = null; next.poolPage = 0; next.search = ''; }
      else if (action === 'pool') next.selection.poolId = interaction.values[0] === 'all' ? null : interaction.values[0];
      else if (action === 'period') next.selection.period = interaction.values[0];
      else if (action === 'detail') next.selection.detail = ({ summary: 'analysis', analysis: 'detail', detail: 'summary' })[next.selection.detail];
      else if (action === 'dimension') { next.selection.dimension = next.selection.dimension === 'origin' ? 'location' : 'origin'; next.selection.poolId = null; next.poolPage = 0; }
      else if (action === 'next') next.poolPage++;
      else if (action === 'previous') next.poolPage = Math.max(0, next.poolPage - 1);
      else if (action === 'clear-search') { next.search = ''; next.poolPage = 0; }
      else if (action === 'search-submit') { next.search = interaction.fields.getTextInputValue('query').trim().slice(0, 100); next.poolPage = 0; }
      else if (action === 'dates-submit') { next.selection.period = 'custom'; next.selection.from = interaction.fields.getTextInputValue('from').trim(); next.selection.to = interaction.fields.getTextInputValue('to').trim(); dateRange(next.selection); }
      else if (action !== 'refresh') throw Error('不支援的報告操作');
      let ledger = await service.load(next.wallet);
      const needsGavin = next.selection.scope !== 'upgrade' && !ledger.coverage.gavin?.complete;
      const needsUpgrade = ['all', 'upgrade'].includes(next.selection.scope) && ledger.catalog.some(pool => pool.kind === 'upgrade' && pool.supported !== false && !ledger.coverage[pool.id]?.complete);
      if (action === 'refresh' || needsGavin || needsUpgrade) ({ ledger } = await service.query(next.wallet, { scope: next.selection.scope }));
      const body = await payload(ledger, next);
      if (interaction.message?.edit) await interaction.message.edit(body); else await interaction.editReply(body);
      await viewStore.saveView(next, view.revision);
    } catch (error) {
      logger.error('wallet_v2_interaction_failed', error.code || error.name);
      const content = '此操作暫時無法完成，原資料與已保存進度仍保留。請檢查選項或稍後再試。';
      if (status) await status.edit({ content, allowedMentions: { parse: [] } });
      else if (interaction.deferred || interaction.replied) await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
      else await privateReply(interaction, content);
    } finally { if (view && acquired) busy.delete(view.id); }
  };
}
