import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { bootstrapActivityVolume, ensureNodeIdentity, ActivityVolumeError, ActivityIdentityError } from './activity-volume.mjs';
import { initializeActivityStartup, isActivityStartupBlockCode } from '../activity/startup-context.mjs';

// Test fixtures may inject only the final Bot loader; production always imports this exact entry.
export async function runContainerStartup({ loadBot = () => import('../discord-bot.mjs') } = {}) {
  let state;
  try { state = { ...bootstrapActivityVolume(), activityUnavailable: null }; }
  catch (error) {
    if (!(error instanceof ActivityVolumeError) || error instanceof ActivityIdentityError || !isActivityStartupBlockCode(error.code)) throw error;
    // Storage may have failed before the strict helper reached its drop step.
    // Never load prestart or the host until the independent identity check passes.
    const identity = ensureNodeIdentity();
    state = { enabled: process.env.ACTIVITY_ENABLED === 'true', ...identity, activityUnavailable: error.code };
    console.error('Activity module unavailable:', error.code);
  }
  initializeActivityStartup({ activityUnavailable: state.activityUnavailable });
  await import('./verify-cat-assets.mjs');
  await import('./verify-poster-browser.mjs');
  await loadBot();
  return Object.freeze(state);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await runContainerStartup(); }
  catch (error) { console.error(error instanceof ActivityVolumeError ? error.code : 'BOT_CONTAINER_START_FAILED'); process.exitCode = 1; }
}
