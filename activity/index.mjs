import { randomUUID } from 'node:crypto';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { activityConfig } from './config.mjs';
import { ActivityApi } from './api.mjs';
import { ActivityJournal } from './journal.mjs';
import { ActivityWorker } from './worker.mjs';

const noMentions = { parse: [], repliedUser: false };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const option = (name, description, type = 3, extra = {}) => ({ name, description, type, ...extra });
export const commandData = {
  name: 'activity', name_localizations: { 'zh-TW': '活動' }, description: 'Activity tasks and private submission receipts',
  description_localizations: { 'zh-TW': '活動任務、私人提交與收據狀態' }, dm_permission: false,
  options: [
    option('list', 'List available activity tasks', 1),
    option('start', 'Open your private task thread', 1, { options: [option('task', 'Task ID from /activity list', 3, { required: true })] }),
    option('submit', 'Submit from your own private task thread', 1, { options: [option('text', 'Task content; leave empty to open a form', 3, { max_length: 6000 }), option('evidence', 'Evidence file', 11)] }),
    option('status', 'Read only your own durable submission receipts', 1, { options: [option('receipt', 'Optional receipt ID or interaction ID', 3)] }),
  ],
};
class ActivityOperationError extends Error { constructor(code) { super(code); this.code = code; } }
const fail = code => { throw new ActivityOperationError(code); };
const errorText = code => ({
  ACTIVITY_FORBIDDEN: '你目前無法在此處使用活動功能。測試環境只開放指定身分組。',
  ACTIVITY_WRONG_CHANNEL: '請在指定活動頻道或你自己的活動私人討論串使用此指令。',
  ACTIVITY_THREAD_OWNER: '只能在你自己的活動私人討論串提交。',
  ACTIVITY_TASK_UNAVAILABLE: '目前無法使用這項任務，請以 /activity list 查看有效任務。',
  ACTIVITY_THREAD_RECOVERY: '討論串預約正在核對，系統已保留紀錄，不會重複建立。請稍後再試或聯絡管理員。',
  ACTIVITY_JOURNAL_WRITE_FAILED: '無法確認資料已安全保存，因此目前不會送交驗證。請用 /activity status 查詢並聯絡管理員；不要把處理中畫面當作受理成功。',
  ACTIVITY_MODAL_EXPIRED: '表單已過期或不是由此帳號開啟，這次尚未受理。請重新使用 /activity submit。',
  ACTIVITY_EMPTY_SUBMISSION: '請填寫任務內容或附上證據。',
  ACTIVITY_INVALID_EVIDENCE: '附件資料無效，請重新選擇 Discord 附件。',
  ACTIVITY_SOURCE_NOT_READY: '活動來源尚未就緒或租約已過期，這次尚未受理，請稍後再試。',
  ACTIVITY_MAINTENANCE: '系統維護中，暫停新的任務受理；已取得收據的提交仍會補送與處理。你可繼續用 /activity status 查詢。',
  MAINTENANCE: '系統維護中，暫停新的任務入口與提交；已取得的收據仍會保留處理。',
  ACTIVITY_ADMISSION_CLOSED: '這個活動已截止並關閉新提交，這次尚未受理。已取得收據的內容會繼續補送與驗證。',
  ACTIVITY_ORIGINAL_CONFLICT: '相同提交識別碼已有首次保存內容，不能覆寫。請聯絡管理員核對。',
  ACTIVITY_RECEIPT_NOT_FOUND: '找不到屬於你的這張收據。',
  identity_required: '請先在活動網站綁定 Discord 帳號。',
  enrollment_required: '請先在活動網站參加這個活動。',
}[code] ?? '這項活動操作暫時未完成。若已取得收據，提交仍會保留；請稍後用 /activity status 查詢。');

/** Host integration only. The host owns Client, login, intents and registration. */
export function createActivityModule({ client, env = process.env, logger = console, fetchImpl = fetch, storagePath, now = Date.now }) {
  const config = activityConfig(env, storagePath), api = new ActivityApi(config, fetchImpl, now);
  let journal, worker, timer, parent, stopped = false, started = false, startError = null, opening = new Set(), active = new Set(), inFlightAdmissions = 0;
  const modals = new Map();
  const closingActivities = new Set(), activityHandlers = new Map();
  function assertAccepting() {
    if (worker?.maintenanceActive()) fail('ACTIVITY_MAINTENANCE');
    if (!worker?.canAdmit()) fail('ACTIVITY_SOURCE_NOT_READY');
    return true;
  }
  const track = promise => { active.add(promise); void promise.finally(() => active.delete(promise)).catch(() => {}); return promise; };
  const privateReply = (interaction, content) => interaction.editReply({ content: content.slice(0, 1950), allowedMentions: noMentions });
  function memberHasRole(interaction) {
    const roles = interaction.member?.roles;
    return Array.isArray(roles) ? roles.includes(config.moderatorRoleId) : !!roles?.cache?.has(config.moderatorRoleId);
  }
  function authorized(interaction, threadRequired = false) {
    if (interaction.guildId !== config.guildId || interaction.user?.bot || (config.moderatorRoleId && !memberHasRole(interaction))) fail('ACTIVITY_FORBIDDEN');
    const link = journal.links.get(interaction.channelId);
    if (threadRequired) { if (!link || link.discordUserId !== interaction.user.id) fail('ACTIVITY_THREAD_OWNER'); }
    else if (interaction.channelId !== config.channelId && (!link || link.discordUserId !== interaction.user.id)) fail('ACTIVITY_WRONG_CHANNEL');
    return link;
  }
  async function configuredParent() {
    const channel = await client.channels.fetch(config.channelId);
    if (!channel || channel.type !== ChannelType.GuildText || channel.guildId !== config.guildId) fail('ACTIVITY_CHANNEL_CONFIG');
    if (channel.parentId !== config.supportCategoryId) fail('ACTIVITY_SUPPORT_CATEGORY_CONFIG');
    const category = await client.channels.fetch(config.supportCategoryId);
    if (!category || category.type !== ChannelType.GuildCategory || category.guildId !== config.guildId) fail('ACTIVITY_SUPPORT_CATEGORY_CONFIG');
    const permissions = channel.permissionsFor(client.user);
    if (!permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.CreatePrivateThreads, PermissionFlagsBits.SendMessagesInThreads, PermissionFlagsBits.ManageThreads, PermissionFlagsBits.ReadMessageHistory])) fail('ACTIVITY_CHANNEL_PERMISSIONS');
    return channel;
  }
  function validateThread(thread, intent) {
    if (!thread || thread.type !== ChannelType.PrivateThread || thread.guildId !== config.guildId || thread.parentId !== config.channelId || thread.ownerId !== client.user.id) fail('ACTIVITY_THREAD_RECOVERY');
    return thread;
  }
  async function reservedThread(intent, remote) {
    const local = [...journal.links.values()].find(value => value.reservationId === intent.reservationId);
    if (local && remote.thread_id && local.threadId !== remote.thread_id) fail('ACTIVITY_THREAD_RECOVERY');
    const knownId = local?.threadId ?? remote.thread_id;
    if (knownId) return validateThread(await client.channels.fetch(knownId), intent);
    // A deterministic reservation marker permits crash recovery, never blind
    // recreate. Archives are paginated; incomplete scans stay unavailable.
    const name = 'tm-' + intent.reservationId, matches = new Map();
    for (const thread of (await parent.threads.fetchActive()).threads.values()) if (thread.name === name) matches.set(thread.id, thread);
    let before;
    for (let page = 0; page < 50; page++) {
      const result = await parent.threads.fetchArchived({ type: 'private', fetchAll: true, limit: 100, ...(before ? { before } : {}) });
      for (const thread of result.threads.values()) if (thread.name === name) matches.set(thread.id, thread);
      if (!result.hasMore) break;
      const times = [...result.threads.values()].map(thread => thread.archiveTimestamp).filter(Number.isFinite);
      const next = Math.min(...times);
      if (!times.length || page === 49 || (before && next >= before.getTime())) fail('ACTIVITY_THREAD_RECOVERY');
      before = new Date(next);
    }
    if (matches.size !== 1) fail('ACTIVITY_THREAD_RECOVERY');
    return validateThread([...matches.values()][0], intent);
  }
  async function bindThread(intent, thread) {
    validateThread(thread, intent);
    await journal.link({ ...intent, threadId: thread.id });
    await api.completeThread(intent.reservationId, thread.id); await journal.confirmThread(intent.reservationId);
  }
  async function recoverThreads() {
    for (const intent of journal.intents.values()) {
      if (journal.confirmed.has(intent.reservationId)) continue;
      try {
        const remote = await api.reservation(intent.reservationId);
        if (remote.state === 'failed' || remote.state === 'archived') { await journal.confirmThread(intent.reservationId); continue; }
        const thread = await reservedThread(intent, remote); await thread.members.add(intent.discordUserId); await bindThread(intent, thread);
      } catch (error) { logger.warn?.('Activity thread reconciliation:', error?.code ?? 'ACTIVITY_THREAD_RECOVERY'); }
    }
  }
  async function getTasks() {
    return (await api.tasks()).filter(task => task.source === 'discord' && task.enabled !== false && task.guild_id === config.guildId && task.channel_id === config.channelId);
  }
  async function openThread(interaction, taskId) {
    if (!uuid.test(taskId)) fail('ACTIVITY_TASK_UNAVAILABLE');
    const key = interaction.user.id + '/' + taskId;
    if (opening.has(key)) fail('ACTIVITY_THREAD_RECOVERY'); opening.add(key);
    try {
      const task = (await getTasks()).find(value => value.id === taskId); if (!task) fail('ACTIVITY_TASK_UNAVAILABLE');
      const remote = await api.reserve(interaction.user.id, task);
      if (!remote?.id || !remote.task || remote.task.id !== task.id || remote.task.guild_id !== config.guildId || remote.task.channel_id !== config.channelId) fail('ACTIVITY_THREAD_RECOVERY');
      const intent = { reservationId: remote.id, discordUserId: interaction.user.id, taskId: task.id, activityId: task.activity_id, guildId: config.guildId, parentChannelId: config.channelId };
      if (!journal.intents.has(remote.id)) await journal.intent(intent);
      let thread;
      if (remote.created === true && !remote.thread_id && ![...journal.links.values()].some(value => value.reservationId === remote.id)) {
        try { thread = await parent.threads.create({ name: 'tm-' + remote.id, type: ChannelType.PrivateThread, invitable: false, autoArchiveDuration: 1440, reason: 'Top Market activity private task reservation' }); }
        catch (error) {
          // Discord definite 4xx rejection has no unknown create outcome.
          if (error?.status >= 400 && error.status < 500 && error.status !== 429) await api.failThread(remote.id, 'discord_create_rejected').catch(() => {});
          fail('ACTIVITY_THREAD_RECOVERY');
        }
        await journal.link({ ...intent, threadId: thread.id });
      } else thread = await reservedThread(intent, remote);
      if (thread.archived) await thread.setArchived(false, 'Resume activity private task');
      await thread.setInvitable(false);
      await thread.members.add(interaction.user.id); await bindThread(intent, thread);
      await privateReply(interaction, `已建立你的私人任務入口：${thread.url}\n請在串內使用 /activity submit 提交。開啟入口本身不會取得 GP。`);
    } finally { opening.delete(key); }
  }
  async function admit(interaction, link, content, attachment) {
    assertAccepting();
    content = String(content ?? '').trim();
    if (!content && !attachment) fail('ACTIVITY_EMPTY_SUBMISSION');
    if (content.length > 10_000) fail('ACTIVITY_EMPTY_SUBMISSION');
    const evidence = [];
    if (attachment) {
      let url; try { url = new URL(attachment.url); } catch { fail('ACTIVITY_INVALID_EVIDENCE'); }
      if (url.protocol !== 'https:' || !['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname) || url.username || url.password || String(attachment.name ?? '').length > 200 || String(attachment.contentType ?? '').length > 100) fail('ACTIVITY_INVALID_EVIDENCE');
      evidence.push({ url: url.href, filename: String(attachment.name ?? ''), content_type: String(attachment.contentType ?? '') });
    }
    const created = Number(interaction.createdTimestamp ?? interaction.createdAt?.getTime());
    if (!Number.isFinite(created) || created < Date.parse(journal.registeredAt) || created > now() + 30_000) fail('ACTIVITY_SOURCE_NOT_READY');
    const { receipt } = await journal.admit({ source: 'discord', source_event_id: interaction.id, discord_user_id: interaction.user.id,
      activity_id: link.activityId, task_id: link.taskId, guild_id: config.guildId, channel_id: config.channelId, thread_id: link.threadId,
      event_at: new Date(created).toISOString(), content, evidence }, assertAccepting);
    try {
      await privateReply(interaction, `已持久保存並受理；驗證結果與 GP 尚待處理。\n收據：${receipt.receiptId}\n可用 /activity status 查詢。通知失敗不會取消已保存的提交。`);
      await journal.notify(receipt, 'sent');
    } catch { await journal.notify(receipt, 'unknown'); logger.warn?.('Activity receipt notification unknown; durable admission retained'); }
  }
  async function showStatus(interaction, wanted) {
    await journal.settled();
    const own = journal.ownReceipts(interaction.user.id);
    const rows = wanted ? own.filter(row => row.receiptId === wanted || row.envelope.payload.source_event_id === wanted) : own.slice(-5).reverse();
    if (wanted && !rows.length) fail('ACTIVITY_RECEIPT_NOT_FOUND');
    if (!rows.length) return privateReply(interaction, '目前沒有屬於你的持久受理收據。處理中或 Discord 未回應不代表已受理。');
    // Read-through refresh is optional: offline still returns the local durable
    // receipt rather than suggesting that an accepted submission disappeared.
    const ids = rows.map(row => row.eventId).filter(Boolean);
    if (ids.length) {
      try { for (const status of await api.statuses(ids)) { const row = rows.find(item => item.eventId === status.id); if (row) await journal.recordStatus(row, status); } }
      catch (error) { logger.warn?.('Activity receipt refresh:', error?.code ?? 'ACTIVITY_API_UNAVAILABLE'); }
    }
    await privateReply(interaction, rows.map(row => `收據：${row.receiptId}\n提交：${row.envelope.payload.source_event_id}\n狀態：${row.status ?? row.serverStatus}${row.diagnostic ? '\n診斷代碼：' + row.diagnostic : ''}`).join('\n\n'));
  }
  async function operation(interaction) {
    const modal = interaction.isModalSubmit?.() && interaction.customId?.startsWith('tm-activity:');
    const command = interaction.isChatInputCommand?.() && interaction.commandName === 'activity';
    if (!modal && !command) return false;
    if (!started || stopped || !journal || !worker || journal.faulted || worker.fatal) {
      const details = config.errors.length ? ' 缺少或無效設定：' + config.errors.join(', ') : '';
      await interaction.reply({ content: '活動模組尚未啟動，這次尚未受理。' + details, ephemeral: true, allowedMentions: noMentions }); return true;
    }
    let deferred = false, admissionTracked = false, finishAdmission, admissionActivity;
    try {
      const sub = modal ? 'modal' : interaction.options.getSubcommand();
      if (sub === 'submit' || modal) { inFlightAdmissions++; admissionTracked = true; }
      const link = authorized(interaction, sub === 'submit' || modal);
      if ((sub === 'submit' || modal) && link) {
        assertAccepting();
        if (closingActivities.has(link.activityId) || journal.closedActivities.has(link.activityId)) fail('ACTIVITY_ADMISSION_CLOSED');
        admissionActivity = link.activityId;
        const pending = new Promise(yes => { finishAdmission = yes; });
        if (!activityHandlers.has(admissionActivity)) activityHandlers.set(admissionActivity, new Set());
        activityHandlers.get(admissionActivity).add(pending);
        const finish = finishAdmission; finishAdmission = () => { activityHandlers.get(admissionActivity).delete(pending); finish(); };
      }
      if (sub === 'submit' && !interaction.options.getString('text') && !interaction.options.getAttachment('evidence')) {
        const nonce = randomUUID();
        for (const [id, value] of modals) if (value.expiresAt < now()) modals.delete(id);
        modals.set(nonce, { userId: interaction.user.id, guildId: interaction.guildId, threadId: interaction.channelId, expiresAt: now() + 15 * 60_000 });
        await interaction.showModal({ custom_id: 'tm-activity:' + nonce, title: '提交活動任務', components: [{ type: 1, components: [{ type: 4, custom_id: 'content', label: '任務內容（證據附件請改用 slash evidence 選項）', style: 2, required: true, max_length: 4000 }] }] }); return true;
      }
      await interaction.deferReply({ ephemeral: true }); deferred = true;
      if (modal) {
        const nonce = interaction.customId.slice('tm-activity:'.length), form = modals.get(nonce);
        if (!form || form.expiresAt < now() || form.userId !== interaction.user.id || form.guildId !== interaction.guildId || form.threadId !== interaction.channelId) fail('ACTIVITY_MODAL_EXPIRED');
        modals.delete(nonce); await admit(interaction, link, interaction.fields.getTextInputValue('content'), null);
      } else if (sub === 'list') {
        const tasks = await getTasks();
        await privateReply(interaction, tasks.length ? tasks.map(task => `${task.name}\n/activity start task:${task.id}`).join('\n\n') : '目前沒有可參與的 Discord 任務。');
      } else if (sub === 'start') {
        assertAccepting();
        await openThread(interaction, String(interaction.options.getString('task', true)).toLowerCase());
      } else if (sub === 'submit') await admit(interaction, link, interaction.options.getString('text'), interaction.options.getAttachment('evidence'));
      else if (sub === 'status') await showStatus(interaction, interaction.options.getString('receipt'));
      else fail('ACTIVITY_TASK_UNAVAILABLE');
    } catch (error) {
      const code = error?.code ?? 'ACTIVITY_OPERATION_FAILED'; logger.warn?.('Activity interaction:', code);
      const text = errorText(code) + (['identity_required', 'enrollment_required'].includes(code) ? '\n' + config.publicOrigin + '/#community' : '');
      if (deferred) await privateReply(interaction, text).catch(() => {});
      else await interaction.reply({ content: text, ephemeral: true, allowedMentions: noMentions }).catch(() => {});
    } finally { finishAdmission?.(); if (admissionTracked) inFlightAdmissions--; }
    return true;
  }
  async function notifyStatus(receipt) {
    const messages = { queued: '已排入驗證，尚未發放GP', processing: '處理中，尚未發放GP', progress: '有效互動已記錄，尚未達任務目標，本次未發放GP', pending_review: '等待管理員審核，尚未發放GP', failed: '暫時處理失敗，資料保留待重試', completed: '已完成，GP與貢獻紀錄已同步', rejected: '未通過，請確認規則與原因' };
    if (!messages[receipt.status]) return;
    const link = journal.links.get(receipt.envelope.payload.thread_id); if (!link) return;
    if (receipt.statusNotified === receipt.status && (receipt.status !== 'completed' || journal.archived.has(link.reservationId))) return;
    const thread = validateThread(await client.channels.fetch(link.threadId), link);
    // No submission text or attachment URLs leave the private thread.
    if (receipt.statusNotified !== receipt.status) {
      if (thread.archived) await thread.setArchived(false, 'Deliver activity validation status');
      await thread.send({ content: `收據 ${receipt.receiptId}\n${messages[receipt.status]}${receipt.reason ? '\n原因：' + String(receipt.reason).slice(0, 1000) : ''}\n可用 /activity status 查詢。`, allowedMentions: noMentions });
      await journal.statusNotified(receipt); await journal.notify(receipt, 'sent');
    }
    const otherWork = [...journal.receipts.values()].some(row => row.envelope.payload.thread_id === thread.id && (row.serverStatus === 'not_submitted' || (row.eventId && !['completed', 'rejected', 'progress'].includes(row.status))));
    if (receipt.status === 'completed' && !otherWork && inFlightAdmissions === 0) {
      if (!thread.archived) await thread.setArchived(true, 'Activity submission validated');
      await api.archiveThread(link.reservationId); await journal.archiveThread(link.reservationId);
    }
  }
  async function notifyReceipt(receipt) {
    const link = journal.links.get(receipt.envelope.payload.thread_id); if (!link) return;
    const thread = validateThread(await client.channels.fetch(link.threadId), link);
    await thread.send({ content: `提交已持久受理。收據：${receipt.receiptId}\n驗證與 GP 以 /activity status 及活動網站紀錄為準。`, allowedMentions: noMentions });
    await journal.notify(receipt, 'sent');
  }
  async function closeAdmissions(challenge) {
    // Fence new A handlers synchronously before the first await; wait for the
    // finite set already running, then enqueue the durable close after them.
    closingActivities.add(challenge.activityId);
    await Promise.allSettled([...(activityHandlers.get(challenge.activityId) ?? [])]);
    return journal.closeActivity(challenge);
  }
  async function start() {
    if (started) return; if (stopped) throw new ActivityOperationError('ACTIVITY_STOPPED');
    if (config.errors.length) { logger.error?.('Activity configuration fields:', config.errors.join(', ')); throw new ActivityOperationError('ACTIVITY_CONFIG_INVALID'); }
    try {
      journal ??= new ActivityJournal(config.journalPath, config);
      parent = await configuredParent();
      worker ??= new ActivityWorker({ api, journal, client, now, logger, handlersDurable: challenge => !journal.faulted && !!journal.closedActivities.get(challenge.activityId) && !(activityHandlers.get(challenge.activityId)?.size), closeAdmissions, onStatus: notifyStatus, onReceipt: notifyReceipt });
      await worker.start(); await recoverThreads(); if (stopped) throw new ActivityOperationError('ACTIVITY_STOPPED'); started = true; startError = null;
    } catch (error) { startError = error?.code ?? 'ACTIVITY_START_FAILED'; throw error; }
    finally {
      // Recover transient startup/API failures while preserving /wallet.
      if (!stopped && journal && worker && !timer) { timer = setInterval(() => { track((async () => {
        if (!started && !stopped && !worker.fatal && !journal.faulted) { try { parent = await configuredParent(); await worker.start(); await recoverThreads(); started = true; startError = null; } catch { return; } }
        if (started) await worker.flush();
      })()).catch(error => logger.warn?.('Activity scheduler:', error?.code ?? 'ACTIVITY_SCHEDULER_FAILED')); }, 5000); timer.unref?.(); }
    }
  }
  return { commandData, guildId: config.guildId, configurationErrors: [...config.errors], start: () => track(start()),
    handleInteraction: interaction => track(operation(interaction)),
    async stop() { stopped = true; if (timer) clearInterval(timer); await Promise.allSettled([...active]); await worker?.stop(); await journal?.close(); },
    // Operational diagnostics are identifiers/counters only, never tokens or content.
    state: () => ({ started, available: started && !!worker?.canAdmit(), error: worker?.fatal ?? startError, pending: journal?.sourcePending().length ?? 0,
      accepting: !!worker?.canAdmit(), maintenance: !!worker?.maintenanceActive(), admissionConfirmedUntil: worker?.admission.confirmedUntil ?? 0 }),
    flush: () => worker?.flush(),
  };
}
