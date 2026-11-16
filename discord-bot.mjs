import { loadEnvFile } from 'node:process';
import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } from 'discord.js';
import { database } from './worker/history/store.js';
import { readWalletSnapshot, walletCachePage } from './worker/wallet-cache.js';
import { formatReport } from './discord-report.mjs';
import { renderPoster } from './discord-poster.mjs';
import { createWalletHandler } from './discord-interaction.mjs';
import { reserveScan, scanBlocked, recordScanFailure, SCAN_MAX_UNITS, SCAN_BLOCK_WINDOW } from './discord-quota.mjs';

try { loadEnvFile(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
for (const key of ['DISCORD_TOKEN', 'DISCORD_CLIENT_ID']) {
  if (!process.env[key]?.trim()) throw Error(`缺少環境變數 ${key}`);
}
const command = new SlashCommandBuilder().setName('wallet').setDescription('查詢 Top.Market 錢包收支摘要')
  .addStringOption(option => option.setName('address').setDescription('Base 錢包地址').setRequired(true));
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
client.once('ready', async () => {
  try {
    const rest = new REST().setToken(process.env.DISCORD_TOKEN);
    const app = process.env.DISCORD_CLIENT_ID;
    const route = process.env.DISCORD_GUILD_ID ? Routes.applicationGuildCommands(app, process.env.DISCORD_GUILD_ID) : Routes.applicationCommands(app);
    await rest.post(route, { body: command.toJSON() });
    console.log(`Discord bot ready: ${client.user.tag}`);
  } catch (error) { console.error('Discord 指令註冊失敗', error.message); process.exitCode = 1; client.destroy(); }
});
client.on('interactionCreate', createWalletHandler({
  readSnapshot: address => readWalletSnapshot(database(), address),
  readPage: address => walletCachePage(database(), address, undefined, { maxUnits: SCAN_MAX_UNITS, maxMs: 120_000,
    blockWindow: SCAN_BLOCK_WINDOW, indexedWalletTransfers: true }),
  reserveScan: () => reserveScan(database()),
  scanBlocked: address => scanBlocked(database(), address),
  recordScanFailure: address => recordScanFailure(database(), address),
  renderPoster, formatReport,
  configured: () => Boolean(process.env.ALCHEMY_API_KEY?.trim() && process.env.DATABASE_URL?.trim()),
}));
await client.login(process.env.DISCORD_TOKEN);
