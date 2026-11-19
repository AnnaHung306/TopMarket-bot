// Standalone, private-channel trial: do not register commands or handle wallet interactions.
import { Client, GatewayIntentBits } from 'discord.js';
import { createGreetingHandler } from './discord-greetings.mjs';
import { createScamTestHandler } from './discord-scam-test.mjs';
import { acquireTrialLock } from './discord-trial-lock.mjs';

if (!process.env.DISCORD_TOKEN?.trim()) throw new Error('DISCORD_TOKEN is required');
const lock = await acquireTrialLock({ connectionString: process.env.TRIAL_DATABASE_URL });
const scamTestEnabled = process.env.DISCORD_SCAM_TEST_ENABLED === 'true';
const intents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages];
if (scamTestEnabled) intents.push(GatewayIntentBits.MessageContent);
const client = new Client({ intents });
client.once('clientReady', () => console.log(`Private channel trial ready; scam detection ${scamTestEnabled ? 'enabled' : 'disabled'}`));
client.on('messageCreate', createGreetingHandler(client, { canAct: lock.canAct }));
if (scamTestEnabled) client.on('messageCreate', createScamTestHandler({ canAct: lock.canAct }));
let shuttingDown = false;
const heartbeat = setInterval(async () => {
  if (shuttingDown || await lock.canAct()) return;
  console.error('Trial coordination connection lost; stopping this instance');
  await shutdown();
  process.exitCode = 1;
}, 5000);
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(heartbeat);
  await lock.close();
  client.destroy();
}
process.once('SIGTERM', () => { void shutdown(); });
process.once('SIGINT', () => { void shutdown(); });
await client.login(process.env.DISCORD_TOKEN);
