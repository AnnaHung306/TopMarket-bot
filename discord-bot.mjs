import { loadEnvFile } from 'node:process';
import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, MessageFlags } from 'discord.js';
import { database } from './worker/history/store.js';
import { walletCachePage } from './worker/wallet-cache.js';
import { formatReport, getReport } from './discord-report.mjs';

try { loadEnvFile(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
for (const key of ['DISCORD_TOKEN', 'DISCORD_CLIENT_ID']) {
  if (!process.env[key]?.trim()) throw Error(`缺少環境變數 ${key}`);
}
const command = new SlashCommandBuilder().setName('wallet').setDescription('查詢 Top.Market 錢包收支摘要')
  .addStringOption(option => option.setName('address').setDescription('Base 錢包地址').setRequired(true));
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
let busy = false;
client.once('ready', async () => {
  try {
    const rest = new REST().setToken(process.env.DISCORD_TOKEN);
    const app = process.env.DISCORD_CLIENT_ID;
    const route = process.env.DISCORD_GUILD_ID ? Routes.applicationGuildCommands(app, process.env.DISCORD_GUILD_ID) : Routes.applicationCommands(app);
    await rest.post(route, { body: command.toJSON() });
    console.log(`Discord bot ready: ${client.user.tag}`);
  } catch (error) { console.error('Discord 指令註冊失敗', error.message); process.exitCode = 1; client.destroy(); }
});
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'wallet') return;
  const wallet = interaction.options.getString('address', true).trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(wallet)) {
    await interaction.reply({ content: '請輸入有效的 Base 錢包地址（0x 開頭，後接 40 個十六進位字元）。', flags: MessageFlags.Ephemeral }); return;
  }
  if (!process.env.ALCHEMY_API_KEY?.trim() || !process.env.DATABASE_URL?.trim()) {
    await interaction.reply({ content: '機器人已連線，但錢包資料來源尚未完成設定，目前無法產生報表。', flags: MessageFlags.Ephemeral }); return;
  }
  if (busy) { await interaction.reply({ content: '目前有查詢進行中，請稍後再試。', flags: MessageFlags.Ephemeral }); return; }
  busy = true;
  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    let lastUpdate = 0;
    const update = async message => {
      if (Date.now() - lastUpdate > 10000) { lastUpdate = Date.now(); await interaction.editReply(message); }
    };
    const { snapshot, note } = await getReport(wallet, (address, after) => walletCachePage(database(), address, after), update);
    await interaction.editReply(formatReport(wallet, snapshot, note));
  } catch (error) {
    console.error('錢包查詢失敗', error.code || error.name);
    const message = '錢包查詢未完成，請稍後再試；已保存的掃描進度可繼續使用。';
    if (interaction.deferred || interaction.replied) await interaction.editReply(message).catch(() => {});
    else await interaction.reply({ content: message, flags: MessageFlags.Ephemeral }).catch(() => {});
  } finally { busy = false; }
});
await client.login(process.env.DISCORD_TOKEN);
