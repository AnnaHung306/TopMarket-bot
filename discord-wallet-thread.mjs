import { ChannelType, PermissionFlagsBits, ThreadAutoArchiveDuration } from 'discord.js';

export const isPrivateWalletThread = channel => channel?.isThread?.() && channel.type === ChannelType.PrivateThread;
const setupError = (userMessage, cause) => Object.assign(new Error(userMessage, { cause }), {
  code: 'WALLET_PRIVATE_THREAD_SETUP', userMessage,
});
const requiredPermissions = [
  [PermissionFlagsBits.ViewChannel, '檢視頻道'],
  [PermissionFlagsBits.CreatePrivateThreads, '建立私人討論串'],
  [PermissionFlagsBits.SendMessagesInThreads, '在討論串傳送訊息'],
  [PermissionFlagsBits.AttachFiles, '附加檔案'],
];

// New reports always have a private destination. Existing reports are never migrated.
export async function privateWalletThread(interaction, name, { logger = console } = {}) {
  const channel = interaction.channel;
  if (isPrivateWalletThread(channel)) return channel;
  const parent = channel?.isThread?.()
    ? channel.parent || await interaction.guild.channels.fetch(channel.parentId)
    : channel;
  if (parent?.type !== ChannelType.GuildText) throw setupError('此頻道無法建立私人討論串，請在錢包工具箱使用 /wallet。');
  const me = interaction.guild.members.me || await interaction.guild.members.fetchMe();
  const permissions = parent.permissionsFor(me);
  const missing = requiredPermissions.filter(([flag]) => !permissions?.has(flag)).map(([, label]) => `「${label}」`);
  if (missing.length) throw setupError(`機器人缺少${missing.join('、')}權限，請聯絡 MOD；尚未查詢錢包。`);
  let thread;
  try {
    thread = await parent.threads.create({ name, type: ChannelType.PrivateThread, invitable: false,
      autoArchiveDuration: ThreadAutoArchiveDuration.OneDay, reason: 'Private Top.Market wallet report' });
    if (!isPrivateWalletThread(thread)) throw setupError('未能建立私人討論串，報表未傳送，請聯絡 MOD。');
  } catch (error) {
    if (error.userMessage) throw error;
    logger.error('wallet_private_thread_create_failed', error.code || error.name);
    throw setupError('無法建立私人討論串，請 MOD 確認伺服器是否支援，以及機器人的「建立私人討論串」權限後再試。', error);
  }
  try { await thread.members.add(interaction.user.id); }
  catch (error) {
    // This newly created thread is still empty: archive it rather than leaving an inaccessible report.
    try { await thread.setArchived(true, 'Wallet requester could not be added; no report generated'); }
    catch (archiveError) { logger.error('wallet_private_thread_archive_failed', thread.id, archiveError.code || archiveError.name); }
    throw setupError('無法將你加入私人討論串，尚未查詢錢包，請聯絡 MOD 後重試。', error);
  }
  return thread;
}
