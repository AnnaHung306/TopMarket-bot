import { MessageFlags } from 'discord.js';

function logCode(logger, level, code, counters) {
  try { logger[level]?.(code, ...(counters ? [counters] : [])); } catch { /* Logging cannot interrupt draining. */ }
}

/** Track the whole handler, including setup, shared queries, PNG rendering and Discord delivery. */
export function createWalletWorkDrain({ handler, logger = console }) {
  let accepting = true, failureCount = 0, draining;
  const active = new Set();
  function stopAccepting() { accepting = false; }
  function handleInteraction(interaction) {
    try {
      if (!interaction.isChatInputCommand() || interaction.commandName !== 'wallet') return Promise.resolve();
    } catch {
      logCode(logger, 'error', 'WALLET_DISPATCH_FAILED');
      return Promise.resolve();
    }
    if (!accepting) {
      // This is a rejection, never an admitted scan. Notification is best effort
      // while the Discord connection is still available during shutdown.
      return Promise.resolve().then(() => interaction.reply({
        content: '機器人正在維護，暫不接受新的錢包查詢，請稍後再試。',
        flags: MessageFlags.Ephemeral,
      })).catch(() => logCode(logger, 'warn', 'WALLET_SHUTDOWN_NOTICE_FAILED'));
    }
    const record = { failed: false, promise: undefined };
    // Register synchronously before the handler begins at its first microtask.
    record.promise = Promise.resolve().then(() => handler(interaction)).catch(() => {
      record.failed = true; failureCount++;
      logCode(logger, 'error', 'WALLET_HANDLER_FAILED');
    }).finally(() => active.delete(record));
    active.add(record);
    return record.promise;
  }
  function drain() {
    stopAccepting();
    if (!draining) {
      const admitted = [...active];
      draining = Promise.allSettled(admitted.map(record => record.promise)).then(() => ({
        settled: admitted.length, failed: admitted.filter(record => record.failed).length,
      }));
    }
    return draining;
  }
  return { handleInteraction, stopAccepting, drain,
    state: () => ({ accepting, activeCount: active.size, failureCount }) };
}

/** One idempotent shutdown; neither an activity failure nor an early client close skips wallet drain. */
export function createBotShutdown({ walletWork, stopActivity, closeWalletResources, destroyClient, logger = console }) {
  let completion;
  return function shutdown() {
    if (completion) return completion;
    walletWork.stopAccepting();
    const walletDrain = walletWork.drain();
    logCode(logger, 'info', 'BOT_SHUTDOWN_STARTED', { activeWalletHandlers: walletWork.state().activeCount });
    completion = (async () => {
      const failures = [];
      const results = await Promise.allSettled([walletDrain, Promise.resolve().then(stopActivity)]);
      if (results[0].status === 'rejected' || results[0].value.failed) failures.push('WALLET_DRAIN_FAILED');
      if (results[1].status === 'rejected') failures.push('ACTIVITY_STOP_FAILED');
      // A shared poster browser must remain usable until every admitted handler settles.
      try { await closeWalletResources(); } catch { failures.push('WALLET_RESOURCE_CLOSE_FAILED'); }
      try { await destroyClient(); } catch { failures.push('DISCORD_CLIENT_DESTROY_FAILED'); }
      for (const code of failures) logCode(logger, 'error', code);
      logCode(logger, 'info', 'BOT_SHUTDOWN_FINISHED', { failures: failures.length });
      return { ok: failures.length === 0, failures };
    })();
    return completion;
  };
}
