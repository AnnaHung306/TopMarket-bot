// Standalone, private-channel trial: do not register commands or handle wallet interactions.
import { Client, GatewayIntentBits, Partials, PermissionFlagsBits } from 'discord.js';
import { createKeywordReplyHandler } from './discord-keyword-replies.mjs';
import { createRepeatWarningHandler } from './discord-repeat-warning.mjs';
import { createRepeatIncidentStore } from './discord-repeat-incidents.mjs';
import { latestScheduledWindow } from './discord-repeat-windows.mjs';
import { createScamTestHandler, createScamUpdateHandler } from './discord-scam-test.mjs';
import { acquireTrialLock } from './discord-trial-lock.mjs';
import { startDailySummary } from './discord-daily-summary.mjs';
import { createSummaryLifecycle } from './discord-summary-lifecycle.mjs';
import { createSummaryCommand } from './discord-summary-command.mjs';
import { createChannelScope } from './discord-channel-scope.mjs';
import pg from 'pg';

if (!process.env.DISCORD_TOKEN?.trim()) throw new Error('DISCORD_TOKEN is required');
const lock = await acquireTrialLock({ connectionString: process.env.TRIAL_DATABASE_URL, deploymentId: process.env.RAILWAY_DEPLOYMENT_ID });
if (!lock) {
  console.log('Superseded private channel trial instance will not start');
  process.exit(0);
}
const scamTestEnabled = process.env.DISCORD_SCAM_TEST_ENABLED === 'true';
const summaryEnabled = process.env.DISCORD_DAILY_SUMMARY_ENABLED === 'true';
const communityEnabled = process.env.DISCORD_COMMUNITY_MODERATION_ENABLED === 'true';
const inScope = createChannelScope({ communityEnabled });
const intents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent];
const client = new Client({ intents, partials: [Partials.Message] });
const incidentPool = new pg.Pool({ connectionString: process.env.TRIAL_DATABASE_URL });
const incidentStore = createRepeatIncidentStore(incidentPool);
let shuttingDown = false;
const summary = createSummaryLifecycle({
  start: () => startDailySummary({ client, connectionString: process.env.TRIAL_DATABASE_URL, apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_SUMMARY_MODEL?.trim() || 'gpt-6-luna', canAct: async () => !shuttingDown && await lock.canAct(), makeClient: options => new pg.Client(options),
    runOnStart: process.env.DISCORD_DAILY_SUMMARY_TEST_NOW === 'true' }),
  onError: error => { console.error('Daily summary could not start:', error.message); },
});
client.once('clientReady', () => {
  console.log(`Private channel trial ready; scam detection ${scamTestEnabled ? 'enabled' : 'disabled'}`);
  console.log(`Community monitoring ${communityEnabled ? 'enabled' : 'disabled'}`);
  if (communityEnabled && scamTestEnabled) {
    void client.channels.fetch('1548950663008878683').then(channel => {
      const permissions = channel?.permissionsFor?.(channel.guild.members.me);
      console.log(`Chinese moderation permissions: view=${!!permissions?.has(PermissionFlagsBits.ViewChannel)} manageMessages=${!!permissions?.has(PermissionFlagsBits.ManageMessages)}`);
    }).catch(error => console.error('Chinese moderation permission check failed:', error.message));
  }
  if (!summaryEnabled || shuttingDown) return;
  if (!process.env.OPENAI_API_KEY?.trim()) { console.log('Daily summary disabled: API key is missing'); return; }
  summary.start();
});
client.on('messageCreate', createKeywordReplyHandler({ canAct: lock.canAct, inScope }));
if (summaryEnabled && process.env.OPENAI_API_KEY?.trim()) client.on('messageCreate', createSummaryCommand({ client, apiKey: process.env.OPENAI_API_KEY, model: process.env.OPENAI_SUMMARY_MODEL?.trim() || 'gpt-6-luna', canAct: lock.canAct }));
client.on('messageCreate', createRepeatWarningHandler({ canAct: lock.canAct, inScope, recordDetection: async incident => {
  await incidentStore.initialize();
  await incidentStore.record(incident);
  const giveaway = latestScheduledWindow(incident.detectedAt, 10);
  const quiz = latestScheduledWindow(incident.detectedAt, 10);
  const counts = await incidentStore.countDetections({ ...incident, giveaway, quiz });
  return { ...counts, giveawayWindow: giveaway, quizWindow: quiz };
} }));
if (scamTestEnabled) {
  const verifiedLinkMode = process.env.DISCORD_VERIFIED_LINK_MODE || 'off';
  client.on('messageCreate', createScamTestHandler({ canAct: lock.canAct, inScope, verifiedLinkMode }));
  client.on('messageUpdate', createScamUpdateHandler({ canAct: lock.canAct, inScope, verifiedLinkMode }));
}
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
  await incidentPool.end();
  await lock.close();
  client.destroy();
}
process.once('SIGTERM', () => { void shutdown(); });
process.once('SIGINT', () => { void shutdown(); });
await client.login(process.env.DISCORD_TOKEN);
