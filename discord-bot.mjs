import { loadEnvFile } from 'node:process';
import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } from 'discord.js';
import { database } from './worker/history/store.js';
import { formatReport } from './discord-report.mjs';
import { createWalletHandler } from './discord-interaction.mjs';
import { createWalletQuery } from './discord-wallet-query.mjs';
import { createGreetingHandler } from './discord-greetings.mjs';
import { createScamTestHandler } from './discord-scam-test.mjs';

try { loadEnvFile(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
for (const key of ['DISCORD_TOKEN', 'DISCORD_CLIENT_ID']) {
  if (!process.env[key]?.trim()) throw Error(`缺少環境變數 ${key}`);
}
// Gavin's RPC module reads its environment at import time, as in dev.mjs.
const [{ walletCachePage }, { renderGavinPoster: renderPoster }] = await Promise.all([
  import('./worker/wallet-cache.js'),
  import('./discord-gavin-poster.mjs'),
]);
const command = new SlashCommandBuilder().setName('wallet').setDescription('查詢 Top.Market 錢包收支摘要')
  .addStringOption(option => option.setName('address').setDescription('Base 錢包地址').setRequired(true));
const scamTestEnabled = process.env.DISCORD_SCAM_TEST_ENABLED === 'true';
const intents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages];
if (scamTestEnabled) intents.push(GatewayIntentBits.MessageContent);
const client = new Client({ intents });
const queryWallet = createWalletQuery((address, afterBlock) => walletCachePage(database(), address, afterBlock));
client.once('clientReady', async () => {
  try {
    const rest = new REST().setToken(process.env.DISCORD_TOKEN);
    const app = process.env.DISCORD_CLIENT_ID;
    const route = process.env.DISCORD_GUILD_ID ? Routes.applicationGuildCommands(app, process.env.DISCORD_GUILD_ID) : Routes.applicationCommands(app);
    await rest.post(route, { body: command.toJSON() });
    console.log(`Discord bot ready: ${client.user.tag}`);
  } catch (error) { console.error('Discord 指令註冊失敗', error.message); process.exitCode = 1; client.destroy(); }
});
client.on('interactionCreate', createWalletHandler({
  queryWallet, renderPoster, formatReport,
  configured: () => Boolean(process.env.ALCHEMY_API_KEY?.trim() && process.env.DATABASE_URL?.trim()),
}));
client.on('messageCreate', createGreetingHandler(client));
if (scamTestEnabled) client.on('messageCreate', createScamTestHandler());
await client.login(process.env.DISCORD_TOKEN);
