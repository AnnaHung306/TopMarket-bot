import { randomUUID, randomInt } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import { address, dateRange } from './model.mjs';
import { buildReport, textReport } from './report.mjs';
import { viewComponents, reportSelection, controlId as customId } from './report-controls.mjs';
export { viewComponents, walletV2Command } from './report-controls.mjs';
import { csvReport, renderPng } from './exports.mjs';
import { mayManageActivity } from '../daily/moderator-access.mjs';
import { isPrivateWalletThread, privateWalletThread } from '../discord-wallet-thread.mjs';

const loading = () => ({ content: 'loading...', components: [], attachments: [], files: [], embeds: [], allowedMentions: { parse: [] } });
const retryControls = view => view?.revision ? [new ActionRowBuilder().addComponents(new ButtonBuilder()
  .setCustomId(customId(view.id, 'refresh', view.revision)).setLabel('重試').setStyle(ButtonStyle.Primary))] : [];
const controlCatalog = () => [];
const controlsLedger = view => ({ catalog: view.controlCatalog || [] });
export const draftPayload = (view, content = '選項已變更，請按「更新資料」。') => ({ ...loading(), content,
  components: viewComponents(controlsLedger(view), { ...view, phase: 'draft' }) });
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
  const privateReply = (interaction, content) => {
    const body = { content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } };
    if (interaction.deferred && interaction.ephemeral) return interaction.editReply(body);
    return interaction.deferred || interaction.replied ? interaction.followUp(body) : interaction.reply(body);
  };
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
      files: [{ attachment: png, name: 'wallet-report.png' }], attachments: [], allowedMentions: { parse: [] } };
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
    if (autocomplete) return interaction.respond([]);
    let status, view, acquired = false, showingLoading = false, downloadPending = false;
    const started = performance.now(), receivedAt = Date.now(), action = command ? 'query' : match?.[3];
    const trace = stage => logger.info('wallet_v2_action', JSON.stringify({ interactionId: interaction.id,
      viewId: view?.id, action, stage, at: new Date().toISOString(),
      receivedAgeMs: Number.isFinite(interaction.createdTimestamp) ? Math.max(0, receivedAt - interaction.createdTimestamp) : undefined,
      elapsedMs: Math.round(performance.now() - started) }));
    try {
      // Component callbacks expire quickly: acknowledge before database access.
      // Modal opening must itself be the initial response, so it stays separate.
      const opensModal = action === 'period' && interaction.values?.[0] === 'custom';
      if (match && !opensModal) {
        if (['csv', 'png'].includes(action)) await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        else await interaction.deferUpdate();
        trace('acknowledged');
      }
      if (command) {
        const wallet = address(interaction.options.getString('address', true).trim());
        const selection = reportSelection({ scope: 'all', poolId: null,
          period: interaction.options.getString('period') || 'all', from: interaction.options.getString('from'),
          to: interaction.options.getString('to'), dimension: 'location', detail: 'summary' });
        dateRange(selection);
        const inPrivateThread = isPrivateWalletThread(interaction.channel);
        await interaction.deferReply(inPrivateThread ? {} : { flags: MessageFlags.Ephemeral });
        let thread = interaction.channel;
        if (!inPrivateThread) {
          await interaction.editReply({ content: '🔒 貓貓正在建立私人錢包討論串…', files: [await waitingGif()] });
          const name = String(interaction.member?.displayName || interaction.user.username).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 70);
          thread = await privateWalletThread(interaction, `${name} 錢包分析`, { logger });
          await interaction.editReply({ content: `🔒 私人錢包報告：<#${thread.id}>`, attachments: [], files: [], allowedMentions: { parse: [] } });
          status = await thread.send(loading());
        } else status = await interaction.editReply(loading());
        showingLoading = true;
        view = { id: randomUUID().replaceAll('-', ''), ownerId: interaction.user.id, wallet,
          channelId: thread.id, messageId: status.id, selection, poolPage: 0, phase: 'loading', controlsVersion: 1,
          runStartedAt: new Date().toISOString(), createdAt: new Date().toISOString() };
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
      const selectionMigrated = view.selection.scope !== 'all' || Boolean(view.selection.poolId) || view.selection.dimension === 'origin';
      view.selection = reportSelection(view.selection);
      if (busy.has(id)) return privateReply(interaction, '上一個操作正在完成，請稍候。');
      if (revision && Number(revision) !== view.revision || !revision && view.controlsVersion === 1) {
        trace('stale');
        return privateReply(interaction, '報告已更新，請使用最新的選項。');
      }
      if (['scope', 'pool', 'dimension', 'search', 'search-submit', 'clear-search', 'previous', 'next'].includes(action)) {
        view = await viewStore.saveView({ ...view, phase: 'draft', controlCatalog: [], controlsVersion: 1 }, view.revision);
        await interaction.message.edit(draftPayload(view));
        return;
      }
      if (selectionMigrated && action !== 'refresh') {
        view = await viewStore.saveView({ ...view, phase: 'draft', controlCatalog: [], controlsVersion: 1 }, view.revision);
        await interaction.message.edit(draftPayload(view));
        if (['png', 'csv'].includes(action)) return privateReply(interaction, '請先按「更新資料」產生新版錢包報告，再下載。');
      }
      if (action === 'period' && interaction.values?.[0] === 'custom') return interaction.showModal(
        new ModalBuilder().setCustomId(customId(id, 'dates-submit', view.revision)).setTitle('自訂日期（台灣時間）')
          .addComponents(input('from', '起日 YYYY-MM-DD', view.selection.from), input('to', '迄日 YYYY-MM-DD', view.selection.to)));
      if (['csv', 'png'].includes(action)) {
        if (view.phase !== 'ready' && view.phase != null) return privateReply(interaction, '請先按「更新資料」產生報告，再下載。');
        await interaction.editReply(loading());
        downloadPending = true;
        const report = buildReport(await service.load(view.wallet), view.selection);
        const file = action === 'csv' ? Buffer.from(csvReport(report)) : await renderPoster(report);
        await interaction.editReply({ content: '', attachments: [], files: [{ attachment: file, name: `wallet-report.${action}` }], allowedMentions: { parse: [] } });
        downloadPending = false;
        return;
      }
      busy.add(id);
      acquired = true;
      const next = { ...view, selection: { ...view.selection } };
      if (action === 'period') next.selection.period = interaction.values[0];
      else if (action === 'detail') next.selection.detail = next.selection.detail === 'summary' ? 'detail' : 'summary';
      else if (action === 'dates-submit') { next.selection.period = 'custom'; next.selection.from = interaction.fields.getTextInputValue('from').trim(); next.selection.to = interaction.fields.getTextInputValue('to').trim(); dateRange(next.selection); }
      else if (action !== 'refresh') throw Error('不支援的報告操作');
      dateRange(next.selection);
      if (action !== 'refresh') {
        const selectionChanged = JSON.stringify(next.selection) !== JSON.stringify(view.selection);
        if (!selectionChanged) {
          trace('unchanged');
          return;
        }
        if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
        // Save only small menu metadata. Changing requirements never scans or renders.
        next.controlCatalog = [];
        next.phase = 'draft';
        view = await viewStore.saveView({ ...next, controlsVersion: 1 }, view.revision);
        await interaction.message.edit(draftPayload(view));
        trace('draft');
        return;
      }
      // Acknowledge and replace the old text/PNG before any ledger read, scan or render.
      await interaction.message.edit(loading());
      showingLoading = true; trace('loading');
      // Store the requested filters before work, so an error can retry those filters.
      view = await viewStore.saveView({ ...next, phase: 'loading', runStartedAt: new Date().toISOString(), controlsVersion: 1 }, view.revision);
      const { ledger } = await service.query(view.wallet, { scope: view.selection.scope, force: true });
      const result = await completed(ledger, view); view = result.view;
      await interaction.message.edit(result.body);
      showingLoading = false; trace('ready');
    } catch (error) {
      logger.error('wallet_v2_interaction_failed', error.code || error.name);
      trace('failed');
      if (Number(error.code) === 10062) {
        trace('expired');
        // Never send a second callback using an expired token. Use the bot's
        // message endpoint, only after rechecking owner, location and revision.
        if (match && interaction.message?.edit) {
          const latest = await viewStore.loadView(match[1]);
          if (!latest || latest.ownerId !== interaction.user.id || latest.channelId !== interaction.channelId ||
            latest.messageId !== interaction.message.id || busy.has(latest.id) ||
            match[2] && Number(match[2]) !== latest.revision || !match[2] && latest.controlsVersion === 1) return;
          busy.add(latest.id); acquired = true; view = latest;
          view = await viewStore.saveView({ ...view, phase: 'draft', controlsVersion: 1 }, view.revision);
          await interaction.message.edit(draftPayload(view, '⏱️ 這次操作已逾時，請再按「更新資料」。'));
        } else if (command && isPrivateWalletThread(interaction.channel) && interaction.channel?.send) {
          await interaction.channel.send({ content: '⏱️ Discord 連線逾時，請重新使用 /wallet。', allowedMentions: { parse: [] } });
        }
        return;
      }
      if (view?.revision && (view.phase === 'loading' || showingLoading)) {
        view = { ...view, phase: 'draft' };
        try { view = await viewStore.saveView(view, view.revision); }
        catch (stateError) { logger.error('wallet_v2_failure_state_unsaved', view.id, stateError.code || stateError.name); }
      }
      const content = error.userMessage || (view?.revision ? '讀取失敗，請按重試。' : '讀取失敗，請重新使用 /wallet。');
      const failure = view?.revision && view.controlCatalog ? draftPayload(view, '讀取失敗，請按「更新資料」重試。')
        : { ...loading(), content, components: retryControls(view) };
      if (status) await status.edit(failure);
      else if (command && interaction.deferred) await interaction.editReply(failure);
      else if (showingLoading) await interaction.message.edit(failure);
      else if (downloadPending) await interaction.editReply({ ...loading(), content: '下載失敗，請再試一次。' });
      else if (interaction.deferred || interaction.replied) await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
      else await privateReply(interaction, content);
    } finally { if (view && acquired) busy.delete(view.id); }
  };
}
