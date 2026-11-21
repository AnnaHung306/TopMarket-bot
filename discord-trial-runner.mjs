// Standalone, private-channel trial: do not register commands or handle wallet interactions.
import { Client, GatewayIntentBits } from 'discord.js';
import { createGreetingHandler } from './discord-greetings.mjs';
import { createScamTestHandler } from './discord-scam-test.mjs';
import { acquireTrialLock } from './discord-trial-lock.mjs';
import { startDailySummary } from './discord-daily-summary.mjs';
import { createSummaryLifecycle } from './discord-summary-lifecycle.mjs';
import pg from 'pg';

if (!process.env.DISCORD_TOKEN?.trim()) throw new Error('DISCORD_TOKEN is required');
const lock = await acquireTrialLock({ connectionString: process.env.TRIAL_DATABASE_URL, deploymentId: process.env.RAILWAY_DEPLOYMENT_ID });
if (!lock) {
  console.log('Superseded private channel trial instance will not start');
  process.exit(0);
}
const scamTestEnabled = process.env.DISCORD_SCAM_TEST_ENABLED === 'true';
const summaryEnabled = process.env.DISCORD_DAILY_SUMMARY_ENABLED === 'true';
const intents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages];
if (scamTestEnabled || summaryEnabled) intents.push(GatewayIntentBits.MessageContent);
const client = new Client({ intents });
let shuttingDown = false;
const summary = createSummaryLifecycle({
  start: () => startDailySummary({ client, connectionString: process.env.TRIAL_DATABASE_URL, apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_SUMMARY_MODEL?.trim() || 'gpt-6-luna', canAct: async () => !shuttingDown && await lock.canAct(), makeClient: options => new pg.Client(options),
    runOnStart: process.env.DISCORD_DAILY_SUMMARY_TEST_NOW === 'true' }),
  onError: error => { console.error('Daily summary could not start:', error.message); },
});
client.once('clientReady', () => {
  console.log(`Private channel trial ready; scam detection ${scamTestEnabled ? 'enabled' : 'disabled'}`);
  if (!summaryEnabled || shuttingDown) return;
  if (!process.env.OPENAI_API_KEY?.trim()) { console.log('Daily summary disabled: API key is missing'); return; }
  summary.start();
});
client.on('messageCreate', createGreetingHandler(client, { canAct: lock.canAct }));
if (scamTestEnabled) client.on('messageCreate', createScamTestHandler({ canAct: lock.canAct }));
const heartbeat = setInterval(async () => {
  if (shuttingDown || await lock.canAct()) return;
  console.log(lock.superseded ? 'New private channel trial instance is taking over' : 'Trial coordination connection lost; stopping this instance');
  await shutdown();
  process.exitCode = lock.superseded ? 0 : 1;
}, 5000);
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(heartbeat);
  await summary.close();
  await lock.close();
  client.destroy();
}
process.once('SIGTERM', () => { void shutdown(); });
process.once('SIGINT', () => { void shutdown(); });
await client.login(process.env.DISCORD_TOKEN);
