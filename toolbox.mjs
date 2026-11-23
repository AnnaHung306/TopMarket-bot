import { ChannelType, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { dateKey, eventTimes, isActivityDay } from './daily/time.mjs';
import { scanSnapshotChannel } from './daily/message-snapshot.mjs';
import { mayManageActivity } from './daily/moderator-access.mjs';

const DAY = 86400000;
const id = /^\d{17,20}$/;
export const toolboxCommands = [
  new SlashCommandBuilder().setName('times').setDescription('私密查詢本場活動的發言次數'),
  new SlashCommandBuilder().setName('bindwallet').setDescription('私密綁定或更改自己的 Base 錢包地址')
    .addStringOption(o => o.setName('address').setDescription('Base 錢包公開地址；不需私鑰或助記詞').setRequired(true)),
  new SlashCommandBuilder().setName('mywallet').setDescription('私密查看自己綁定的錢包地址'),
].map(c => c.toJSON());

export function activeWindow(now) {
  for (const day of [dateKey(now - DAY), dateKey(now)]) {
    if (!isActivityDay(day)) continue;
    const { start, end } = eventTimes(day, 'quiz');
    if (now >= start && now < end) return { start, end };
  }
  return null;
}

export async function countMessages({ guild, categoryId, userId, start, end }) {
  const all = await guild.channels.fetch();
  const channels = [...all.values()].filter(c => c?.parentId === categoryId && c.type === ChannelType.GuildText);
  if (!channels.length) throw Error('DAILY_GROUP_CHANNELS_MISSING');
  let count = 0;
  for (const channel of channels) {
    const scan = await scanSnapshotChannel(channel, { member: guild.members.me, start, end: end + 1 });
    count += scan.entries.filter(entry => entry.user_id === userId).length;
  }
  return count;
}

export async function initializeToolbox(sql) {
  if (typeof sql.transaction !== 'function') throw Error('TOOLBOX_TRANSACTIONS_REQUIRED');
  await sql.transaction([
    sql`SELECT pg_advisory_xact_lock(hashtextextended('discord_wallet_bindings_schema',0))`,
    sql`CREATE TABLE IF NOT EXISTS discord_wallet_bindings (guild_id text NOT NULL, user_id text NOT NULL, address text NOT NULL, request_id text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (guild_id,user_id))`,
  ]);
}

const stamp = t => `<t:${Math.floor(t / 1000)}:F>`;
export function createToolboxHandler({ sql, env = process.env, now = Date.now, logger = console }) {
  return async interaction => {
    if (!interaction.isChatInputCommand() || !['times','bindwallet','mywallet'].includes(interaction.commandName)) return;
    const allowed = env.DISCORD_WALLET_CHANNEL_ID?.trim();
    const channel = interaction.channel;
    const inToolbox = allowed && (interaction.channelId === allowed || (channel?.isThread() && channel.parentId === allowed));
    const guildId = env.DAILY_GUILD_ID?.trim();
    const modChannelId = env.DAILY_MOD_CHANNEL_ID?.trim();
    const moderatorRoleId = env.DAILY_MODERATOR_ROLE_ID?.trim();
    const inModChannel = [guildId, modChannelId, moderatorRoleId].every(value => id.test(value || '')) &&
      mayManageActivity(interaction, { guildId, modChannelId, moderatorRoleId });
    if (!interaction.guildId || (!inToolbox && !inModChannel)) return interaction.reply({ content: allowed ? '請在 bot-toolbox 使用此指令。' : '工具箱尚未完成設定，請聯絡 MOD。', flags: MessageFlags.Ephemeral });
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      if (interaction.commandName === 'times') {
        const at = now(), window = activeWindow(at);
        if (!window) return interaction.editReply('目前沒有進行中的每日活動，因此沒有本場發言計數。活動於週一至週五台灣時間 10:00 開始，次日 09:00 結束。');
        const categoryId = env.DAILY_GROUP_CATEGORY_ID?.trim();
        if (env.DAILY_ENABLED !== 'true' || !id.test(categoryId || '') || interaction.guildId !== env.DAILY_GUILD_ID?.trim()) throw Error('DAILY_CONFIGURATION_MISSING');
        const count = await countMessages({ guild: interaction.guild, categoryId, userId: interaction.user.id, start: window.start, end: at });
        return interaction.editReply(`本場符合規則的發言：**${count} 則**\n計數區間：${stamp(window.start)} 至 ${stamp(at)}（含）\n資料截止：${stamp(at)}\n僅計 Group Chat 文字頻道的訊息；討論串、機器人及已刪除訊息不計。`);
      }
      if (!id.test(interaction.guildId) || !id.test(interaction.user.id) || !id.test(interaction.id)) throw Error('TOOLBOX_ID_INVALID');
      await initializeToolbox(sql);
      if (interaction.commandName === 'bindwallet') {
        const address = interaction.options.getString('address', true).trim().toLowerCase();
        if (!/^0x[0-9a-f]{40}$/.test(address)) return interaction.editReply('地址格式不正確，請輸入 0x 開頭、後接 40 個十六進位字元的 Base 公開地址；不要提供私鑰或助記詞。');
        const rows = await sql`INSERT INTO discord_wallet_bindings(guild_id,user_id,address,request_id) VALUES (${interaction.guildId},${interaction.user.id},${address},${interaction.id}) ON CONFLICT(guild_id,user_id) DO UPDATE SET address=excluded.address,request_id=excluded.request_id,updated_at=now() WHERE discord_wallet_bindings.request_id::numeric < excluded.request_id::numeric RETURNING address`;
        if (!rows.length) return interaction.editReply('已有較新的綁定操作，請使用 /mywallet 查看目前地址。');
        return interaction.editReply(`已儲存你的地址：\`${address}\`\n這僅是地址紀錄，尚未透過簽名驗證錢包所有權。`);
      }
      const [row] = await sql`SELECT address FROM discord_wallet_bindings WHERE guild_id=${interaction.guildId} AND user_id=${interaction.user.id}`;
      return interaction.editReply(row ? `你綁定的地址：\`${row.address}\`\n此地址的所有權尚未透過簽名驗證。` : '你尚未綁定地址，可使用 /bindwallet 設定。');
    } catch (error) {
      logger.error('TOOLBOX_REQUEST_FAILED', error.code || error.message);
      return interaction.editReply('目前無法完整取得資料或儲存設定，請稍後再試或聯絡 MOD。');
    }
  };
}
