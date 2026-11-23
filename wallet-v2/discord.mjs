import { randomUUID, randomInt } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, ModalBuilder, SlashCommandBuilder,
  StringSelectMenuBuilder, TextInputBuilder, TextInputStyle, ThreadAutoArchiveDuration } from 'discord.js';
import { SCOPES, address, dateRange, displayPoolName } from './model.mjs';
import { buildReport, textReport } from './report.mjs';
import { csvReport, renderPng } from './exports.mjs';
import { mayManageActivity } from '../daily/moderator-access.mjs';

// Exported definition only. Nothing in this module logs in, registers commands or changes the active bot.
export const walletV2Command = new SlashCommandBuilder().setName('wallet').setDescription('查詢錢包收益，依活動與期間篩選')
  .addStringOption(option => option.setName('address').setDescription('Base 錢包地址').setRequired(true))
  .addStringOption(option => option.setName('scope').setDescription('分析範圍；也可查完再切換').addChoices(
    ...Object.entries(SCOPES).map(([value, name]) => ({ name, value }))))
  .addStringOption(option => option.setName('period').setDescription('時間範圍').addChoices(
    { name: '全期間', value: 'all' }, { name: '近 7 天', value: '7d' }, { name: '近 30 天', value: '30d' },
    { name: '本月', value: 'month' }, { name: '自訂日期', value: 'custom' }))
  .addStringOption(option => option.setName('from').setDescription('自訂起日 YYYY-MM-DD，台灣時間'))
  .addStringOption(option => option.setName('to').setDescription('自訂迄日 YYYY-MM-DD，台灣時間'));

const customId = (id, action, revision) => `wv2:${id}:${revision ? revision + ':' : ''}${action}`;
const loading = () => ({ content: 'loading...', components: [], attachments: [], files: [], embeds: [], allowedMentions: { parse: [] } });
const retryControls = view => view?.revision ? [new ActionRowBuilder().addComponents(new ButtonBuilder()
  .setCustomId(customId(view.id, 'refresh', view.revision)).setLabel('重試').setStyle(ButtonStyle.Primary))] : [];
const controlCatalog = ledger => ledger.catalog.map(({ id, kind, name, enabled }) => ({ id, kind, name, enabled }));
const controlsLedger = view => ({ catalog: view.controlCatalog || [] });
const draftPayload = (view, content = '選項已變更，請按「更新資料」。') => ({ ...loading(), content,
  components: viewComponents(controlsLedger(view), { ...view, phase: 'draft' }) });
function poolChoices(ledger, view) {
  let pools = ledger.catalog.filter(pool => pool.kind === 'packs');
  if (view.search) pools = pools.filter(pool => displayPoolName(pool).toLowerCase().includes(view.search.toLowerCase()));
  return pools;
}
const hasPackFilter = selection => ['all', 'packs', 'buyback'].includes(selection.scope);
function tidySelection(selection) {
  return { ...selection, dimension: 'location', poolId: hasPackFilter(selection) ? selection.poolId : null };
}
export function viewComponents(ledger, view) {
  const pools = poolChoices(ledger, view), pages = Math.max(1, Math.ceil(pools.length / 23));
  const page = Math.max(0, Math.min(view.poolPage || 0, pages - 1));
  const pagePools = pools.slice(page * 23, (page + 1) * 23);
  const selected = pools.find(pool => pool.id === view.selection.poolId) || ledger.catalog.find(pool => pool.kind === 'packs' && pool.id === view.selection.poolId);
  if (selected && !pagePools.some(pool => pool.id === selected.id)) pagePools.push(selected);
  const options = [{ label: '所有卡包', value: 'all', default: !selected },
    ...pagePools.map(pool => ({ label: displayPoolName(pool).slice(0, 100), value: pool.id, default: pool.id === selected?.id,
      ...(pool.enabled === false ? { description: '已結束' } : {}) }))];
  const select = (action, placeholder, options) => new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
    .setCustomId(customId(view.id, action, view.revision)).setPlaceholder(placeholder).addOptions(options));
  const button = (action, label, style = ButtonStyle.Secondary) => new ButtonBuilder().setCustomId(customId(view.id, action, view.revision)).setLabel(label).setStyle(style);
  const rows = [select('scope', '選擇收益範圍', Object.entries(SCOPES).map(([value, label]) => ({ label, value, default: value === view.selection.scope })))];
  const showPacks = hasPackFilter(view.selection) && pools.length > 0;
  if (showPacks) rows.push(select('pool', pages > 1 ? `選擇卡包 ${page + 1}/${pages}` : '選擇卡包', options));
  rows.push(
    select('period', '選擇期間', [['all', '全期間'], ['7d', '近 7 天'], ['30d', '近 30 天'], ['month', '本月'], ['custom', '自訂日期']]
      .map(([value, label]) => ({ label, value, default: value === view.selection.period }))),
    new ActionRowBuilder().addComponents(button('detail', view.selection.detail === 'summary' ? '詳細報表' : '收合明細'),
      button('png', '下載 PNG').setDisabled(view.phase === 'draft'), button('csv', '匯出 CSV').setDisabled(view.phase === 'draft'),
      button('refresh', '更新資料', ButtonStyle.Primary)));
  if (hasPackFilter(view.selection) && (pages > 1 || view.search)) {
    const navigation = [button('search', '搜尋卡包')];
    if (view.search) navigation.push(button('clear-search', '清除搜尋'));
    if (page > 0) navigation.push(button('previous', '上一頁'));
    if (page < pages - 1) navigation.push(button('next', '下一頁'));
    rows.push(new ActionRowBuilder().addComponents(...navigation));
  }
  return rows;
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
    return { content: textReport(report),
      files: [{ attachment: png, name: 'wallet-v2.png' }], attachments: [], allowedMentions: { parse: [] } };
  }
  async function completed(ledger, view) {
    const body = await payload(ledger, view);
    const ready = await viewStore.saveView({ ...view, phase: 'ready', controlCatalog: controlCatalog(ledger) }, view.revision);
    return { view: ready, body: { ...body, components: viewComponents(ledger, ready) } };
  }
  return async interaction => {
    const command = interaction.isChatInputCommand?.() && interaction.commandName === 'wallet';
    const autocomplete = interaction.isAutocomplete?.() && interaction.commandName === 'wallet';
    const match = /^wv2:([a-f0-9]{32}):(?:(\d+):)?([a-z-]+)$/.exec(interaction.customId || '');
    if (!command && !autocomplete && !match) return;
    if (!permitted(interaction)) {
      if (autocomplete) return interaction.respond([]);
      return privateReply(interaction, '請在已設定的工具箱頻道或其討論串使用錢包分析。');
    }
    if (autocomplete) {
      if (!hasPackFilter({ scope: interaction.options.getString('scope') || 'all' })) return interaction.respond([]);
      const wallet = interaction.options.getString('address');
      if (!/^0x[\da-f]{40}$/i.test(wallet || '')) return interaction.respond([]);
      const ledger = await service.load(wallet);
      const query = String(interaction.options.getFocused()).toLowerCase();
      return interaction.respond(ledger.catalog.filter(pool => pool.kind === 'packs' && displayPoolName(pool).toLowerCase().includes(query))
        .slice(0, 25).map(pool => ({ name: displayPoolName(pool).slice(0, 100), value: pool.id })));
    }
    let status, view, acquired = false, showingLoading = false, downloadPending = false;
    const started = performance.now(), action = command ? 'query' : match?.[3];
    const trace = stage => logger.info('wallet_v2_action', JSON.stringify({ interactionId: interaction.id,
      viewId: view?.id, action, stage, elapsedMs: Math.round(performance.now() - started) }));
    try {
      if (command) {
        const wallet = address(interaction.options.getString('address', true).trim());
        const selection = { scope: interaction.options.getString('scope') || 'all', poolId: null,
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
          status = await thread.send(loading());
        } else status = await interaction.editReply(loading());
        showingLoading = true;
        view = { id: randomUUID().replaceAll('-', ''), ownerId: interaction.user.id, wallet,
          channelId: thread.id, messageId: status.id, selection, poolPage: 0, phase: 'draft', controlsVersion: 1, createdAt: new Date().toISOString() };
        view = await viewStore.saveView(view);
        trace('loading');
        const { ledger } = await service.query(wallet, { scope: selection.scope });
        const result = await completed(ledger, view); view = result.view;
        await status.edit(result.body);
        showingLoading = false; trace('ready');
        return;
      }
      const [, id, revision] = match;
      view = await viewStore.loadView(id);
      if (!view) return privateReply(interaction, '這份報告的操作資料無法讀取，請重新查詢。');
      if (view.ownerId !== interaction.user.id) return privateReply(interaction, '這是其他成員的報告；請使用 /wallet 建立自己的分析。');
      if (view.channelId !== interaction.channelId || view.messageId && interaction.message?.id !== view.messageId)
        return privateReply(interaction, '報告與目前討論串不相符，請回原報告操作。');
      view.selection = tidySelection(view.selection);
      if (busy.has(id)) return privateReply(interaction, '上一個操作正在完成，請稍候。');
      if (revision && Number(revision) !== view.revision || !revision && view.controlsVersion === 1) {
        trace('stale');
        return privateReply(interaction, '報告已更新，請使用最新的選項。');
      }
      if (['pool', 'search', 'search-submit', 'clear-search', 'previous', 'next'].includes(action) && !hasPackFilter(view.selection))
        return privateReply(interaction, '這個活動不需要選擇卡包，點「更新資料」即可使用精簡介面。');
      if (action === 'search') return interaction.showModal(new ModalBuilder().setCustomId(customId(id, 'search-submit', view.revision))
        .setTitle('搜尋卡包').addComponents(input('query', '卡包名稱', view.search)));
      if (action === 'period' && interaction.values?.[0] === 'custom') return interaction.showModal(
        new ModalBuilder().setCustomId(customId(id, 'dates-submit', view.revision)).setTitle('自訂日期（台灣時間）')
          .addComponents(input('from', '起日 YYYY-MM-DD', view.selection.from), input('to', '迄日 YYYY-MM-DD', view.selection.to)));
      if (['csv', 'png'].includes(action)) {
        if (view.phase === 'draft') return privateReply(interaction, '請先按「更新資料」產生報告，再下載。');
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await interaction.editReply(loading());
        downloadPending = true;
        const report = buildReport(await service.load(view.wallet), view.selection);
        const file = action === 'csv' ? Buffer.from(csvReport(report)) : await renderPoster(report);
        await interaction.editReply({ content: '', attachments: [], files: [{ attachment: file, name: `wallet-v2.${action}` }], allowedMentions: { parse: [] } });
        downloadPending = false;
        return;
      }
      busy.add(id);
      acquired = true;
      const next = { ...view, selection: { ...view.selection } };
      if (action === 'scope') {
        if (interaction.values[0] !== view.selection.scope) {
          next.selection.scope = interaction.values[0]; next.selection.poolId = null; next.poolPage = 0; next.search = '';
        }
      }
      else if (action === 'pool') next.selection.poolId = interaction.values[0] === 'all' ? null : interaction.values[0];
      else if (action === 'period') next.selection.period = interaction.values[0];
      else if (action === 'detail') next.selection.detail = next.selection.detail === 'summary' ? 'detail' : 'summary';
      else if (action === 'dimension') { next.selection.dimension = 'location'; next.selection.poolId = null; next.poolPage = 0; }
      else if (action === 'next') next.poolPage++;
      else if (action === 'previous') next.poolPage = Math.max(0, next.poolPage - 1);
      else if (action === 'clear-search') { next.search = ''; next.poolPage = 0; }
      else if (action === 'search-submit') { next.search = interaction.fields.getTextInputValue('query').trim().slice(0, 100); next.poolPage = 0; }
      else if (action === 'dates-submit') { next.selection.period = 'custom'; next.selection.from = interaction.fields.getTextInputValue('from').trim(); next.selection.to = interaction.fields.getTextInputValue('to').trim(); dateRange(next.selection); }
      else if (action !== 'refresh') throw Error('不支援的報告操作');
      if (!SCOPES[next.selection.scope]) throw Error('無效範圍');
      dateRange(next.selection);
      if (action !== 'refresh') {
        const selectionChanged = JSON.stringify(next.selection) !== JSON.stringify(view.selection);
        const menuChanged = (next.search || '') !== (view.search || '') || (next.poolPage || 0) !== (view.poolPage || 0);
        if (!selectionChanged && !menuChanged) {
          await interaction.deferUpdate(); trace('unchanged');
          return;
        }
        await interaction.deferUpdate();
        // Save only small menu metadata. Changing requirements never scans or renders.
        next.controlCatalog = view.controlCatalog || controlCatalog(await service.load(view.wallet));
        next.phase = selectionChanged ? 'draft' : view.phase || 'ready';
        view = await viewStore.saveView({ ...next, controlsVersion: 1 }, view.revision);
        await interaction.editReply(selectionChanged ? draftPayload(view) : { components: viewComponents(controlsLedger(view), view) });
        trace(selectionChanged ? 'draft' : 'controls');
        return;
      }
      // Acknowledge and replace the old text/PNG before any ledger read, scan or render.
      await interaction.update(loading());
      showingLoading = true; trace('loading');
      // Store the requested filters before work, so an error can retry those filters.
      view = await viewStore.saveView({ ...next, phase: 'draft', controlsVersion: 1 }, view.revision);
      const { ledger } = await service.query(view.wallet, { scope: view.selection.scope });
      const result = await completed(ledger, view); view = result.view;
      await interaction.editReply(result.body);
      showingLoading = false; trace('ready');
    } catch (error) {
      logger.error('wallet_v2_interaction_failed', error.code || error.name);
      trace('failed');
      const content = view?.revision ? '讀取失敗，請按重試。' : '讀取失敗，請重新使用 /wallet。';
      const failure = view?.revision && view.controlCatalog ? draftPayload(view, '讀取失敗，請按「更新資料」重試。')
        : { ...loading(), content, components: retryControls(view) };
      if (status) await status.edit(failure);
      else if (showingLoading) await interaction.editReply(failure);
      else if (downloadPending) await interaction.editReply({ ...loading(), content: '下載失敗，請再試一次。' });
      else if (interaction.deferred || interaction.replied) await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
      else await privateReply(interaction, content);
    } finally { if (view && acquired) busy.delete(view.id); }
  };
}
