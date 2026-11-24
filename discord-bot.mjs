import { loadEnvFile } from 'node:process';
import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } from 'discord.js';
import { database, postgresSql } from './worker/history/store.js';
import pg from 'pg';
import { formatReport } from './discord-report.mjs';
import { createWalletHandler } from './discord-interaction.mjs';
import { createWalletQuery } from './discord-wallet-query.mjs';
import { createDailyModule } from './daily/index.mjs';
import { createToolboxHandler, toolboxCommands } from './toolbox.mjs';
import { createProductionWalletV2 } from './wallet-v2/runtime.mjs';

try { loadEnvFile(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
for (const key of ['DISCORD_TOKEN', 'DISCORD_CLIENT_ID']) {
  if (!process.env[key]?.trim()) throw Error(`缺少環境變數 ${key}`);
}
// Gavin's RPC module reads its environment at import time, as in dev.mjs.
const [{ walletCachePage }, { renderGavinPoster: renderPoster }] = await Promise.all([
  import('./worker/wallet-cache.js'),
  import('./discord-gavin-poster.mjs'),
]);
const walletV2 = await createProductionWalletV2();
const command = walletV2?.command || new SlashCommandBuilder().setName('wallet').setDescription('查詢 Top.Market 錢包收支摘要')
  .addStringOption(option => option.setName('address').setDescription('Base 錢包地址').setRequired(true));
const intents = [GatewayIntentBits.Guilds];
if (process.env.DAILY_ENABLED === 'true' && process.env.DAILY_PUBLIC_ACTIVITY_ENABLED === 'true' && process.env.DAILY_VERIFIED_ROLE_ID) intents.push(GatewayIntentBits.GuildMembers);
const client = new Client({ intents });
let daily;
if (process.env.DAILY_ENABLED === 'true') {
  try {
    const sql = database();
    const incidentSql = process.env.DAILY_INCIDENT_DATABASE_URL?.trim()
      ? postgresSql(new pg.Pool({connectionString:process.env.DAILY_INCIDENT_DATABASE_URL})) : sql;
    daily = createDailyModule({ client, sql, incidentSql });
  }
  catch (error) { console.error('DAILY_CONFIGURATION_FAILED', error.message); }
}
const queryWallet = createWalletQuery((address, afterBlock) => walletCachePage(database(), address, afterBlock));
client.once('clientReady', async () => {
  try {
    const rest = new REST().setToken(process.env.DISCORD_TOKEN);
    const app = process.env.DISCORD_CLIENT_ID;
    const route = process.env.DISCORD_GUILD_ID ? Routes.applicationGuildCommands(app, process.env.DISCORD_GUILD_ID) : Routes.applicationCommands(app);
    await rest.post(route, { body: command.toJSON() });
    for (const body of toolboxCommands) await rest.post(route, { body });
    if (walletV2) {
      try { console.info('wallet_v2_startup_recovery', JSON.stringify(await walletV2.recoverInterruptedReports(client))); }
      catch (error) { console.error('WALLET_V2_STARTUP_RECOVERY_FAILED', error.code || error.name); }
    }
    if (daily) {
      try {
        for (const body of daily.commands) await rest.post(Routes.applicationGuildCommands(app, daily.guildId), { body });
        await daily.start();
      } catch (error) { console.error('DAILY_START_FAILED', error.message); }
    }
    console.log(`Discord bot ready: ${client.user.tag}`);
  } catch (error) { console.error('Discord 指令註冊失敗', error.message); process.exitCode = 1; client.destroy(); }
});
const walletHandler = walletV2?.handle || createWalletHandler({
  queryWallet, renderPoster, formatReport,
  configured: () => Boolean(process.env.ALCHEMY_API_KEY?.trim() && process.env.DATABASE_URL?.trim()),
});
client.on('interactionCreate', interaction => void walletHandler(interaction).catch(error => console.error('WALLET_INTERACTION_FAILED', error.code || error.name)));
let toolboxDatabase;
const getToolboxDatabase = () => toolboxDatabase ||= database();
const toolboxSql = (...args) => getToolboxDatabase()(...args);
toolboxSql.transaction = queries => getToolboxDatabase().transaction(queries);
const toolboxHandler = createToolboxHandler({ sql: toolboxSql });
client.on('interactionCreate', interaction => void toolboxHandler(interaction).catch(error => console.error('TOOLBOX_INTERACTION_FAILED', error)));
if (daily) client.on('interactionCreate', interaction => void daily.handle(interaction).catch(error => console.error('DAILY_INTERACTION_FAILED', error)));
await client.login(process.env.DISCORD_TOKEN);
