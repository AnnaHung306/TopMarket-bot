import { MessageFlags, ThreadAutoArchiveDuration } from 'discord.js';
import { readFile } from 'node:fs/promises';
import { randomInt } from 'node:crypto';
import { SCAN_ATTEMPTS, SCAN_MAX_MS, SCAN_MAX_UNITS } from './discord-quota.mjs';

const assetsDirectory = new URL('./assets/tenor-cat-wait/', import.meta.url);
const waitingText = '貓貓正在努力工作，請稍後... 完成後會拍拍通知';
let waitingAssetsPromise;

async function waitingAsset(chooseIndex = randomInt) {
  waitingAssetsPromise ??= readFile(new URL('manifest.json', assetsDirectory), 'utf8')
    .then(JSON.parse).catch(error => {
      console.error('無法讀取等待動畫清單', error.code || error.name);
      waitingAssetsPromise = undefined;
      return [];
    });
  const candidates = [...await waitingAssetsPromise];
  while (candidates.length) {
    const [entry] = candidates.splice(chooseIndex(candidates.length), 1);
    if (!entry || !/^[a-z0-9-]+\.gif$/.test(entry.file) ||
        entry.license !== '未確認' || !entry.source?.startsWith('https://tenor.com/')) {
      console.error('等待動畫授權資料不完整，已略過');
      continue;
    }
    try {
      const gif = await readFile(new URL(entry.file, assetsDirectory));
      return { files: [{ attachment: gif, name: 'cat-wait.gif' }] };
    } catch (error) {
      console.error('無法讀取等待動畫', entry.file, error.code || error.name);
    }
  }
  return { files: [] };
}

const validWallet = wallet => /^0x[0-9a-f]{40}$/.test(wallet);
function safeError(error) {
  let detail = String(error?.message || 'Unknown error');
  for (const key of ['ALCHEMY_API_KEY', 'DATABASE_URL', 'DISCORD_TOKEN', 'ETHERSCAN_API_KEY']) {
    const secret = process.env[key];
    if (secret) detail = detail.split(secret).join('[redacted]');
  }
  return detail.replace(/(?:https?|postgres(?:ql)?):\/\/\S+/gi, '[redacted-url]')
    .replace(/password\s*[=:]\s*\S+/gi, 'password=[redacted]').slice(0, 300);
}
const threadName = interaction => {
  const username = String(interaction.member?.displayName || interaction.user.displayName || interaction.user.username)
    .replace(/[\u0000-\u001f\u007f]/g, ' ').trim() || '用戶';
  const suffix = ' 錢包報表查詢';
  return username.slice(0, 100 - suffix.length) + suffix;
};

export function createWalletHandler({ readPage, readSnapshot, reserveScan, scanBlocked = async () => false,
  recordScanFailure = async () => {}, renderPoster, formatReport, configured, chooseWaitingIndex = randomInt }) {
  let busy = false;
  const failedWallets = new Map();
  return async interaction => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== 'wallet') return;
    const commandStarted = performance.now();
    const allowedChannel = process.env.DISCORD_WALLET_CHANNEL_ID?.trim();
    if (allowedChannel && interaction.channelId !== allowedChannel) {
      await interaction.reply({ content: '請在指定的 MOD 工具箱頻道使用此指令。', flags: MessageFlags.Ephemeral });
      return;
    }
    const wallet = interaction.options.getString('address', true).trim().toLowerCase();
    let status, ownsBusy = false;
    const editStatus = message => status.edit(message);
    try {
      await interaction.deferReply();
      const animation = await waitingAsset(chooseWaitingIndex);
      await interaction.editReply({
        content: waitingText,
        files: animation.files,
      });
      let thread;
      try {
        thread = await interaction.channel.threads.create({
          name: threadName(interaction),
          autoArchiveDuration: ThreadAutoArchiveDuration.OneHour,
          reason: 'Top.Market wallet report',
        });
        await interaction.editReply({ content: `${waitingText}\n進度與報表請見 <#${thread.id}>` });
      } catch (error) {
        console.error('無法建立錢包討論串', error.code || error.name);
        await interaction.editReply('已收到查詢，但無法建立討論串。請確認機器人在此頻道有「建立公開討論串」及「在討論串傳送訊息」權限。');
        return;
      }
      try {
        status = await thread.send('正在檢查地址與已儲存報表。');
      }
      catch (error) {
        console.error('無法在錢包討論串回覆', error.code || error.name);
        await interaction.editReply('討論串已建立，但機器人無法在串內回覆。請確認「在討論串傳送訊息」及「附加檔案」權限。');
        return;
      }
      if (!validWallet(wallet)) {
        await editStatus('請輸入有效的 Base 錢包地址（0x 開頭，後接 40 個十六進位字元）。'); return;
      }
      if (!configured()) {
        await editStatus('機器人已連線，但錢包資料來源尚未完成設定，目前無法產生報表。'); return;
      }
      const cached = await readSnapshot(wallet);
      if (cached) {
        const note = '顯示已儲存的摘要，未自動查詢最新區塊。';
        const poster = renderPoster(wallet, cached, note);
        await thread.send({ content: `拍拍 <@${interaction.user.id}>\n${formatReport(wallet, cached, note)}`,
          allowedMentions: { users: [interaction.user.id] }, files: [{ attachment: poster, name: 'wallet-report.png' }] });
        await editStatus('已完成：文字報表與 PNG 海報已傳到此討論串。');
        return;
      }
      if (busy) { await editStatus('目前有查詢進行中，請稍後再試。'); return; }
      busy = true; ownsBusy = true;
      const today = new Date().toISOString().slice(0, 10);
      for (const [key, day] of failedWallets) if (day !== today) failedWallets.delete(key);
      if (failedWallets.has(wallet) || await scanBlocked(wallet)) {
        await editStatus('此錢包今天的掃描曾失敗，為避免重複消耗 API，暫停重試至 UTC 零點。已儲存的進度不受影響。'); return;
      }
      await editStatus('找不到已儲存報表，正在掃描歷史資料；本次消耗設有上限，請稍候。');
      if (!await reserveScan()) {
        await editStatus('今日背景掃描額度已用完；已完成的進度會保留，請於 UTC 零點後再試。'); return;
      }
      const budget = { maxUnits: SCAN_MAX_UNITS, units: 0, deadline: commandStarted + SCAN_MAX_MS };
      let result, lastError, through = -1, pages = 0;
      for (let attempt = 1; attempt <= SCAN_ATTEMPTS; attempt++) {
        try {
          while (performance.now() < budget.deadline && budget.units < budget.maxUnits && pages < 100) {
            result = await readPage(wallet, budget);
            if (result?.ready) break;
            if (result?.waiting) throw Error('Wallet scan is locked');
            const next = Number(result?.progress?.through);
            if (!Number.isSafeInteger(next) || next <= through) throw Error('Wallet scan made no checkpoint progress');
            through = next;
            pages++;
            console.info(`錢包掃描已保存第 ${pages} 頁`, `through=${through}`, `estimated_units=${budget.units}`);
          }
          if (result?.ready) break;
          throw Error(`Wallet scan limit reached; pages=${pages} estimated_units=${budget.units}`);
        } catch (error) {
          lastError = error;
        }
        // Incomplete Gavin pages are successful checkpoints, not failures.
        // Only a stalled page or exhausted shared limit counts as a failed pass.
        console.error(`錢包掃描第 ${attempt} 次未完成`, lastError.code || lastError.name,
          `pages=${pages}`, `estimated_units=${budget.units}`);
      }
      if (!result?.ready) {
        failedWallets.set(wallet, today);
        try { await recordScanFailure(wallet); }
        catch (recordError) { console.error('無法保存掃描保護狀態', recordError.code || recordError.name); }
        const adminId = process.env.DISCORD_ADMIN_ID?.trim();
        await editStatus('兩次掃描仍未完成，已通知 MOD 協助；請勿重複送出。');
        await thread.send({
          content: `${adminId && /^\d{17,20}$/.test(adminId) ? `<@${adminId}>` : '@en'} 錢包 ${wallet} 連續兩次掃描未完成，請協助查核。`,
          allowedMentions: { users: adminId && /^\d{17,20}$/.test(adminId) ? [adminId] : [] },
        });
        console.error('錢包查詢兩次失敗', lastError?.code || lastError?.name, safeError(lastError));
        return;
      }
      if (result.ready) {
        const poster = renderPoster(wallet, result.snapshot, '');
        await thread.send({ content: `拍拍 <@${interaction.user.id}>\n${formatReport(wallet, result.snapshot, '')}`,
          allowedMentions: { users: [interaction.user.id] }, files: [{ attachment: poster, name: 'wallet-report.png' }] });
        await editStatus('已完成：文字報表與 PNG 海報已傳到此討論串。');
        return;
      }
    } catch (error) {
      console.error('錢包查詢失敗', error.code || error.name, safeError(error));
      const message = failedWallets.has(wallet)
        ? '錢包掃描未完成。為避免重複消耗 API，這個錢包暫停掃描至 UTC 零點；若先前有保存進度，會從保存的位置繼續。'
        : '錢包查詢未完成，請稍後再試；若已有保存的掃描進度，將從上次進度繼續。';
      if (status) await editStatus(message).catch(() => {});
      else if (interaction.replied || interaction.deferred) await interaction.editReply(message).catch(() => {});
      else await interaction.reply({ content: message }).catch(() => {});
    } finally { if (ownsBusy) busy = false; }
  };
}
