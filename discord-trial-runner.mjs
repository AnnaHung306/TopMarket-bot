// Standalone, private-channel trial: do not register commands or handle wallet interactions.
import { Client, GatewayIntentBits } from 'discord.js';
import { createGreetingHandler } from './discord-greetings.mjs';
import { createScamTestHandler } from './discord-scam-test.mjs';

if (!process.env.DISCORD_TOKEN?.trim()) throw new Error('DISCORD_TOKEN is required');
const scamTestEnabled = process.env.DISCORD_SCAM_TEST_ENABLED === 'true';
const intents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages];
if (scamTestEnabled) intents.push(GatewayIntentBits.MessageContent);
const client = new Client({ intents });
client.once('clientReady', () => console.log(`Private channel trial ready; scam detection ${scamTestEnabled ? 'enabled' : 'disabled'}`));
client.on('messageCreate', createGreetingHandler(client));
if (scamTestEnabled) client.on('messageCreate', createScamTestHandler());
await client.login(process.env.DISCORD_TOKEN);
