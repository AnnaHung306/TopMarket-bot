import { MessageFlags, ThreadAutoArchiveDuration } from 'discord.js';
import { readFile } from 'node:fs/promises';
import { randomInt } from 'node:crypto';
import { notifyAdminFailure } from './discord-failure.mjs';

const assetsDirectory = new URL('./assets/tenor-cat-wait/', import.meta.url);
const waitingText = '貓貓正在努力工作，請稍後... 完成後會拍拍通知';
const CACHE_REFRESH_AFTER_MS = 24 * 60 * 60 * 1_000;
let waitingAssetsPromise;

export function shouldRefreshSnapshot(snapshot, now = Date.now()) {
  const asOf = Date.parse(snapshot?.asOf ?? '');
  return Boolean(snapshot?.rebuildRequired || !Number.isFinite(asOf) ||
    asOf > now + 5 * 60 * 1_000 || now - asOf >= CACHE_REFRESH_AFTER_MS);
}

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

export function createWalletHandler({ readSnapshot, enqueueScan, scanBlocked = async () => false,
  wake = () => {}, renderPoster, formatReport, configured, chooseWaitingIndex = randomInt }) {
  return async interaction => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== 'wallet') return;
    const allowedChannel = process.env.DISCORD_WALLET_CHANNEL_ID?.trim();
    if (allowedChannel && interaction.channelId !== allowedChannel) {
      await interaction.reply({ content: '請在指定的 MOD 工具箱頻道使用此指令。', flags: MessageFlags.Ephemeral });
      return;
    }
    const wallet = interaction.options.getString('address', true).trim().toLowerCase();
    let status;
    const editStatus = message => status.edit(message);
    let thread, preflightFailedTwice = false;
    const retryPreflight = async (work, label) => {
      try { return await work(); }
      catch (error) {
        console.error(`${label} 第一次未完成，背景重試`, error.code || error.name, safeError(error));
        try { return await work(); }
        catch (retryError) { preflightFailedTwice = true; throw retryError; }
      }
    };
    try {
      await interaction.deferReply();
      const animation = await waitingAsset(chooseWaitingIndex);
      await interaction.editReply({
        content: waitingText,
        files: animation.files,
      });
      try {
        thread = await interaction.channel.threads.create({
          name: threadName(interaction),
          autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
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
      const cached = await retryPreflight(() => readSnapshot(wallet), '已存報表讀取');
      if (cached) {
        const note = '顯示已儲存的摘要，未自動查詢最新區塊。';
        let delivered = false;
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            const poster = await renderPoster(wallet, cached, note);
            await thread.send({ content: `拍拍 <@${interaction.user.id}>\n${formatReport(wallet, cached, note)}`,
              allowedMentions: { users: [interaction.user.id] }, files: [{ attachment: poster, name: 'wallet-report.png' }] });
            delivered = true;
            break;
          }
          catch (error) {
            console.error(`已存報表傳送第 ${attempt} 次未完成`, error.code || error.name, safeError(error));
          }
        }
        if (!delivered) {
          await editStatus('已存報表連續兩次未能傳送，已通知 MOD 協助；不會消耗 Alchemy 額度。');
          await notifyAdminFailure(thread, wallet, '已存報表連續兩次未能傳送');
          return;
        }
        if (!shouldRefreshSnapshot(cached)) {
          await editStatus('已完成：文字報表與 PNG 海報已傳到此討論串。')
            .catch(error => console.error('無法更新完成狀態', error.code || error.name));
          return;
        }
        if (await retryPreflight(() => scanBlocked(wallet), '掃描狀態讀取')) {
          await editStatus('已送出上次保存的報表；此錢包今日的背景刷新已停止並通知 MOD。');
          return;
        }
        const refresh = await retryPreflight(() => enqueueScan({ wallet, threadId: thread.id,
          requesterId: interaction.user.id, statusId: status.id, afterBlock: cached.through }), '錢包刷新排程');
        if (refresh.existingThreadId && refresh.existingThreadId !== thread.id) {
          await editStatus(`已送出上次保存的報表；最新區塊正在 <#${refresh.existingThreadId}> 背景更新。`);
          return;
        }
        if (refresh.full) {
          await editStatus('已送出上次保存的報表；更新佇列已滿，請稍後再試。本次沒有使用 Alchemy 額度。');
          return;
        }
        await editStatus('已送出上次保存的報表；快取需要更新，已排入限額背景工作，完成後會再拍拍通知。');
        wake();
        return;
      }
      if (await retryPreflight(() => scanBlocked(wallet), '掃描狀態讀取')) {
        await editStatus('此錢包今天的掃描已停止並通知 MOD，暫停新工作至 UTC 零點；已保存的進度不受影響。');
        return;
      }
      const queued = await retryPreflight(() => enqueueScan({ wallet, threadId: thread.id,
        requesterId: interaction.user.id, statusId: status.id }), '錢包工作排程');
      if (queued.existingThreadId && queued.existingThreadId !== thread.id) {
        await editStatus(`此錢包正在 <#${queued.existingThreadId}> 背景掃描；請到原討論串查看進度。`);
        return;
      }
      if (queued.full) {
        await editStatus('背景掃描佇列已滿，請稍後再試；本次沒有使用 Alchemy 額度。');
        return;
      }
      await editStatus('已排入背景掃描，目前尚未開始鏈上查詢；此處會更新掃描進度，完整報表完成後會拍拍通知。');
      wake();
    } catch (error) {
      console.error('錢包查詢失敗', error.code || error.name, safeError(error));
      if (preflightFailedTwice && status && thread) {
        await editStatus('前置資料連續兩次無法讀取，已通知 MOD 協助；本次沒有使用 Alchemy 額度。')
          .catch(updateError => console.error('無法更新前置讀取錯誤狀態', updateError.code || updateError.name));
        await notifyAdminFailure(thread, wallet, '前置資料連續兩次無法讀取')
          .catch(alertError => console.error('無法通知 MOD', alertError.code || alertError.name));
        return;
      }
      const message = '錢包查詢尚未建立，請稍後再試；若已有保存的掃描進度，將從上次進度繼續。';
      if (status) await editStatus(message).catch(() => {});
      else if (interaction.replied || interaction.deferred) await interaction.editReply(message).catch(() => {});
      else await interaction.reply({ content: message }).catch(() => {});
    }
  };
}
