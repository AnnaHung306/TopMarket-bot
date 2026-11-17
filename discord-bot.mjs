import { loadEnvFile } from 'node:process';
import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } from 'discord.js';
import { database } from './worker/history/store.js';
import { readWalletSnapshot, readWalletProgress, walletCachePage } from './worker/wallet-cache.js';
import { formatReport } from './discord-report.mjs';
import { renderGavinPoster as renderPoster } from './discord-gavin-poster.mjs';
import { createWalletHandler } from './discord-interaction.mjs';
import { reserveScan, releaseUnusedScan, scanBlocked, recordScanFailure, SCAN_BLOCK_WINDOW, pageUnitLimit } from './discord-quota.mjs';
import { claimScanJob, enqueueScanJob, removeScanJob, renewScanLease, rescheduleScanJob } from './discord-scan-jobs.mjs';
import { createScanRunner } from './discord-scan-runner.mjs';

try { loadEnvFile(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
for (const key of ['DISCORD_TOKEN', 'DISCORD_CLIENT_ID']) {
  if (!process.env[key]?.trim()) throw Error(`缺少環境變數 ${key}`);
}
const command = new SlashCommandBuilder().setName('wallet').setDescription('查詢 Top.Market 錢包收支摘要')
  .addStringOption(option => option.setName('address').setDescription('Base 錢包地址').setRequired(true));
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const jobs = {
  claim: () => claimScanJob(database()),
  enqueue: job => enqueueScanJob(database(), job),
  reschedule: (wallet, options) => rescheduleScanJob(database(), wallet, options),
  renew: wallet => renewScanLease(database(), wallet),
  remove: wallet => removeScanJob(database(), wallet),
};
const readPage = async (address, budget, afterBlock) => {
  const started = performance.now(), before = budget.units;
  const unitLimit = pageUnitLimit(budget);
  let outcome = 'error';
  try {
    const result = await walletCachePage(database(), address, afterBlock, {
      maxUnits: unitLimit,
      maxMs: Math.min(budget.blockWindow === 0 ? 35_000 : 20_000,
        Math.max(1, budget.deadline - performance.now())),
      perSecond: 6_000, maxInFlight: 24, blockWindow: budget.blockWindow ?? SCAN_BLOCK_WINDOW,
      sharedBudget: budget,
    });
    outcome = result.ready ? 'ready' : result.waiting ? 'waiting' : `checkpoint-${result.progress?.through ?? 'none'}`;
    return result;
  } finally {
    console.info('錢包頁面讀取', `outcome=${outcome}`,
      `window=${budget.blockWindow || 'full'}`, `elapsed_ms=${Math.round(performance.now() - started)}`,
      `estimated_units=${budget.units - before}`, `unit_limit=${unitLimit}`);
  }
};
const runner = createScanRunner({ client, jobs, readPage,
  readSnapshot: address => readWalletSnapshot(database(), address),
  readProgress: address => readWalletProgress(database(), address),
  reserveScan: () => reserveScan(database()),
  releaseUnusedScan: () => releaseUnusedScan(database()),
  recordScanFailure: address => recordScanFailure(database(), address),
  renderPoster, formatReport,
});
client.once('clientReady', async () => {
  try {
    const rest = new REST().setToken(process.env.DISCORD_TOKEN);
    const app = process.env.DISCORD_CLIENT_ID;
    const route = process.env.DISCORD_GUILD_ID ? Routes.applicationGuildCommands(app, process.env.DISCORD_GUILD_ID) : Routes.applicationCommands(app);
    await rest.post(route, { body: command.toJSON() });
    console.log(`Discord bot ready: ${client.user.tag}`);
    runner.start();
  } catch (error) { console.error('Discord 指令註冊失敗', error.message); process.exitCode = 1; client.destroy(); }
});
client.on('interactionCreate', createWalletHandler({
  readSnapshot: address => readWalletSnapshot(database(), address),
  enqueueScan: jobs.enqueue,
  scanBlocked: address => scanBlocked(database(), address),
  wake: runner.wake,
  renderPoster, formatReport,
  configured: () => Boolean(process.env.ALCHEMY_API_KEY?.trim() && process.env.DATABASE_URL?.trim()),
}));
await client.login(process.env.DISCORD_TOKEN);
