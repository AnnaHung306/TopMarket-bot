import { SCAN_ATTEMPTS, SCAN_BLOCK_WINDOW, SCAN_MAX_MS, SCAN_MAX_UNITS } from './discord-quota.mjs';
import { nextUtcMidnight } from './discord-scan-jobs.mjs';

const waitUntil = ms => new Date(Date.now() + ms);
const budgetLimit = error => /^Alchemy sync (?:budget|time limit) reached/.test(String(error?.message));
function safeError(error) {
  let detail = String(error?.message || error?.name || 'Unknown error');
  for (const key of ['ALCHEMY_API_KEY', 'DATABASE_URL', 'DISCORD_TOKEN', 'ETHERSCAN_API_KEY']) {
    const secret = process.env[key];
    if (secret) detail = detail.split(secret).join('[redacted]');
  }
  return detail.replace(/(?:https?|postgres(?:ql)?):\/\/\S+/gi, '[redacted-url]')
    .replace(/password\s*[=:]\s*\S+/gi, 'password=[redacted]').slice(0, 200);
}

function progressText(progress) {
  const through = Number(progress?.through), target = Number(progress?.target);
  if (!Number.isSafeInteger(through) || !Number.isSafeInteger(target) || target < through) {
    return '目前尚未取得可保存的檢查點；完整報表完成後會在此通知。';
  }
  const from = Number(progress.from);
  const percent = Number.isSafeInteger(from) && target >= from
    ? `（區塊覆蓋約 ${Math.min(100, Math.max(0, (through - from + 1) / (target - from + 1) * 100)).toFixed(1)}%）`
    : '';
  return `已核對至 Base 區塊 ${through.toLocaleString()} / ${target.toLocaleString()}${percent}。完整報表完成後會在此通知。`;
}

export function createScanRunner({ client, jobs, readPage, readSnapshot, readProgress = async () => null,
  reserveScan, releaseUnusedScan = async () => {}, recordScanFailure,
  renderPoster, formatReport, maxMs = SCAN_MAX_MS, maxUnits = SCAN_MAX_UNITS,
  progressIntervalMs = 20_000 }) {
  let working = false, timer;

  async function fail(job, thread, status, error) {
    const failures = Number(job.failures) + 1;
    console.error(`錢包背景工作第 ${failures} 次未完成`, error.code || error.name, safeError(error));
    if (failures < SCAN_ATTEMPTS) {
      // The first real failure is deliberately invisible to the requester.
      await jobs.reschedule(job.wallet, { failures, nextRunAt: waitUntil(1_000) });
      return;
    }
    // Persist the terminal state before sending Discord messages. If posting
    // fails, a restart can retry the alert without another Alchemy scan.
    const stalled = error.code === 'NO_CHECKPOINT' || Number(job.stalls) >= 3;
    await jobs.reschedule(job.wallet, { failures, stalls: stalled ? 3 : undefined,
      nextRunAt: waitUntil(60_000) });
    await recordScanFailure(job.wallet);
    await status.edit(stalled
      ? '多段掃描仍無法保存新進度，已停止耗用 API 額度並通知 MOD；已保存的進度不受影響。'
      : '兩次掃描仍未完成，已通知 MOD 協助；已保存的進度不受影響。');
    const adminId = process.env.DISCORD_ADMIN_ID?.trim();
    const mention = adminId && /^\d{17,20}$/.test(adminId) ? `<@${adminId}>` : '@en';
    await thread.send({
      content: `${mention} 錢包 ${job.wallet}${stalled ? ' 多段掃描無法保存新進度' : ' 連續兩次掃描未完成'}，請協助查核。`,
      allowedMentions: { users: mention.startsWith('<@') ? [adminId] : [] },
    });
    await jobs.remove(job.wallet);
  }

  async function deliver(job, thread, status, snapshot) {
    const poster = await renderPoster(job.wallet, snapshot, '');
    await thread.send({
      content: `拍拍 <@${job.requester_id}>\n${formatReport(job.wallet, snapshot, '')}`,
      allowedMentions: { users: [job.requester_id] },
      files: [{ attachment: poster, name: 'wallet-report.png' }],
    });
    await jobs.remove(job.wallet);
    await status.edit('已完成：文字報表與 PNG 海報已傳到此討論串。')
      .catch(error => console.error('無法更新完成狀態', error.code || error.name));
  }

  async function processJob(job) {
    let thread, status;
    let terminalAttempted = false;
    let progressTimer, progressEdit = Promise.resolve();
    async function stopProgressTimer() {
      clearInterval(progressTimer);
      progressTimer = undefined;
      await progressEdit;
    }
    try {
      thread = await client.channels.fetch(job.thread_id);
      if (!thread?.isThread?.()) throw Object.assign(Error('Wallet report thread was removed'), { code: 10003 });
      if (thread.archived && !thread.locked) await thread.setArchived(false);
      status = await thread.messages.fetch(job.status_id);
    } catch (error) {
      if ([10003, 10008].includes(error.code)) {
        await jobs.remove(job.wallet);
        return;
      }
      console.error('無法讀取錢包討論串', error.code || error.name);
      await jobs.reschedule(job.wallet, { nextRunAt: waitUntil(60_000) });
      return;
    }

    try {
      if (Number(job.failures) >= SCAN_ATTEMPTS) {
        terminalAttempted = true;
        await fail({ ...job, failures: SCAN_ATTEMPTS - 1 }, thread, status,
          Error('Previous two wallet scan attempts failed'));
        return;
      }
      const saved = await readSnapshot(job.wallet);
      if (saved) { await deliver(job, thread, status, saved); return; }
      let lastProgress = await readProgress(job.wallet);
      if (!await reserveScan()) {
        await status.edit(`${progressText(lastProgress)}\n今日鏈上掃描額度已用完；會在 UTC 零點後自動續掃。`);
        await jobs.reschedule(job.wallet, { nextRunAt: nextUtcMidnight() });
        return;
      }
      await status.edit('正在核對完整歷史；每段掃描設有時間與 API 用量上限。');
      const budget = { maxUnits, units: 0, deadline: performance.now() + maxMs,
        blockWindow: Number(job.block_window) || SCAN_BLOCK_WINDOW };
      let lastThrough = Number(lastProgress?.through ?? -1), pages = 0, failures = Number(job.failures);
      progressTimer = setInterval(() => {
        const message = `${progressText(lastProgress)}\n本段已送出約 ${Math.round(budget.units).toLocaleString()} / ${maxUnits.toLocaleString()} 估算 CU 的鏈上請求。`;
        progressEdit = progressEdit.then(() => status.edit(message)).catch(error =>
          console.error('無法更新錢包掃描進度', error.code || error.name));
      }, progressIntervalMs);
      progressTimer.unref();
      while (performance.now() < budget.deadline && budget.units < maxUnits && pages < 100) {
        let result;
        try {
          result = await readPage(job.wallet, budget);
        } catch (error) {
          if (budgetLimit(error)) break;
          failures++;
          console.error(`錢包掃描第 ${failures} 次未完成`, error.code || error.name,
            `pages=${pages}`, `estimated_units=${budget.units}`);
          if (failures >= SCAN_ATTEMPTS) {
            terminalAttempted = true;
            await stopProgressTimer();
            await fail({ ...job, failures: failures - 1 }, thread, status, error);
            return;
          }
          // Retry once within the same reservation when there is time left.
          if (performance.now() + 2_000 < budget.deadline) continue;
          await stopProgressTimer();
          await jobs.reschedule(job.wallet, { failures, nextRunAt: waitUntil(1_000) });
          return;
        }
        if (result?.ready) {
          await stopProgressTimer();
          await deliver(job, thread, status, result.snapshot);
          return;
        }
        if (result?.waiting) {
          await stopProgressTimer();
          await releaseUnusedScan();
          await jobs.reschedule(job.wallet, { failures, nextRunAt: waitUntil(5_000) });
          return;
        }
        const through = Number(result?.progress?.through);
        if (!Number.isSafeInteger(through) || through <= lastThrough) {
          terminalAttempted = true;
          await stopProgressTimer();
          await fail({ ...job, failures }, thread, status, Error('Wallet scan made no checkpoint progress'));
          return;
        }
        lastThrough = through;
        lastProgress = result.progress;
        pages++;
        console.info(`錢包掃描已保存第 ${pages} 頁`, `through=${through}`, `estimated_units=${budget.units}`);
      }
      await stopProgressTimer();
      if (pages === 0) {
        const stalls = Number(job.stalls || 0) + 1;
        if (stalls >= 3) {
          terminalAttempted = true;
          await fail({ ...job, failures: SCAN_ATTEMPTS - 1 }, thread, status,
            Object.assign(Error('Wallet scan reached three segment limits without a saved checkpoint'),
              { code: 'NO_CHECKPOINT' }));
          return;
        }
        const blockWindow = Math.max(10_000, Math.floor(budget.blockWindow / 5));
        await status.edit(`${progressText(lastProgress)}\n本段未能保存新進度；下段會縮小區塊範圍後重試。`);
        await jobs.reschedule(job.wallet, { failures, stalls, blockWindow, nextRunAt: waitUntil(1_000) });
        console.info('錢包掃描未能保存檢查點，縮小範圍', `stalls=${stalls}`,
          `block_window=${blockWindow}`, `estimated_units=${budget.units}`);
        return;
      }
      await status.edit(`${progressText(lastProgress)}\n本段已達時間或 API 用量上限，系統會自動續掃。`);
      await jobs.reschedule(job.wallet, { failures, stalls: 0, nextRunAt: waitUntil(1_000) });
      console.info('錢包掃描達上限，背景續掃', `pages=${pages}`, `estimated_units=${budget.units}`);
    } catch (error) {
      await stopProgressTimer();
      if (terminalAttempted) {
        console.error('無法送出或保存掃描失敗通知；終止狀態將由佇列重試', error.code || error.name);
        return;
      }
      // Rendering, database and Discord errors are retried without another
      // Alchemy reservation when a completed snapshot is already cached.
      await fail(job, thread, status, error).catch(failure => {
        console.error('無法記錄錢包背景工作錯誤', failure.code || failure.name);
      });
    }
  }

  async function wake() {
    if (working) return;
    working = true;
    try {
      for (;;) {
        const job = await jobs.claim();
        if (!job) break;
        const heartbeat = setInterval(() => {
          if (!jobs.renew) return;
          void jobs.renew(job.wallet).catch(error =>
            console.error('錢包工作租約續期失敗', error.code || error.name));
        }, 15_000);
        heartbeat.unref();
        try { await processJob(job); }
        finally { clearInterval(heartbeat); }
      }
    } catch (error) {
      console.error('錢包背景佇列無法執行', error.code || error.name);
    } finally {
      working = false;
    }
  }

  return {
    wake,
    start() {
      if (timer) return;
      timer = setInterval(() => { void wake(); }, 10_000);
      timer.unref();
      void wake();
    },
    stop() { clearInterval(timer); timer = undefined; },
  };
}
