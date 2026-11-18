import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { bootstrapActivityVolume, ActivityVolumeError } from './activity-volume.mjs';

// Test fixtures may inject only the final Bot loader; production always imports this exact entry.
export async function runContainerStartup({ loadBot = () => import('../discord-bot.mjs') } = {}) {
  const state = bootstrapActivityVolume();
  await import('./verify-cat-assets.mjs');
  await import('./verify-poster-browser.mjs');
  await loadBot();
  return state;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await runContainerStartup(); }
  catch (error) { console.error(error instanceof ActivityVolumeError ? error.code : 'BOT_CONTAINER_START_FAILED'); process.exitCode = 1; }
}
