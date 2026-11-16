import { ThreadAutoArchiveDuration } from 'discord.js';

const validWallet = wallet => /^0x[0-9a-f]{40}$/.test(wallet);

export function createWalletHandler({ readPage, readSnapshot, reserveScan, scanBlocked = async () => false,
  recordScanFailure = async () => {}, renderPoster, formatReport, configured }) {
  let busy = false;
  const failedWallets = new Map();
  return async interaction => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== 'wallet') return;
    const wallet = interaction.options.getString('address', true).trim().toLowerCase();
    let status, ownsBusy = false;
    try {
      await interaction.reply({ content: '已收到 `/wallet` 查詢，正在開啟討論串；進度與報表會在串內更新。' });
      let thread;
      try {
        const starter = await interaction.fetchReply();
        thread = await starter.startThread({
          name: `錢包報表 · ${validWallet(wallet) ? wallet.slice(0, 8) + '…' + wallet.slice(-6) : '地址檢查'}`,
          autoArchiveDuration: ThreadAutoArchiveDuration.OneHour,
          reason: 'Top.Market wallet report',
        });
      } catch (error) {
        console.error('無法建立錢包討論串', error.code || error.name);
        await interaction.editReply('已收到查詢，但無法建立討論串。請確認機器人在此頻道有「建立公開討論串」及「在討論串傳送訊息」權限。');
        return;
      }
      try { status = await thread.send('查詢已進入討論串，正在檢查地址與已儲存報表。'); }
      catch (error) {
        console.error('無法在錢包討論串回覆', error.code || error.name);
        await interaction.editReply('討論串已建立，但機器人無法在串內回覆。請確認「在討論串傳送訊息」及「附加檔案」權限。');
        return;
      }
      if (!validWallet(wallet)) {
        await status.edit('請輸入有效的 Base 錢包地址（0x 開頭，後接 40 個十六進位字元）。'); return;
      }
      if (!configured()) {
        await status.edit('機器人已連線，但錢包資料來源尚未完成設定，目前無法產生報表。'); return;
      }
      if (busy) { await status.edit('目前有查詢進行中，請稍後再試。'); return; }
      busy = true; ownsBusy = true;
      const cached = await readSnapshot(wallet);
      if (cached) {
        const note = '顯示已儲存的摘要，未自動查詢最新區塊。';
        const poster = renderPoster(wallet, cached, note);
        await thread.send({ content: formatReport(wallet, cached, note), files: [{ attachment: poster, name: 'wallet-report.png' }] });
        await status.edit('已完成：文字報表與 PNG 海報已傳到此討論串。');
        return;
      }
      const today = new Date().toISOString().slice(0, 10);
      for (const [key, day] of failedWallets) if (day !== today) failedWallets.delete(key);
      if (failedWallets.has(wallet) || await scanBlocked(wallet)) {
        await status.edit('此錢包今天的掃描曾失敗，為避免重複消耗 API，暫停重試至 UTC 零點。已儲存的進度不受影響。'); return;
      }
      await status.edit('找不到已儲存報表，正在掃描歷史資料；本次消耗設有上限，請稍候。');
      if (!await reserveScan()) {
        await status.edit('今日背景掃描額度已用完；已完成的進度會保留，請於 UTC 零點後再試。'); return;
      }
      let result;
      try { result = await readPage(wallet); }
      catch (error) {
        failedWallets.set(wallet, today);
        try { await recordScanFailure(wallet); }
        catch (recordError) { console.error('無法保存掃描保護狀態', recordError.code || recordError.name); }
        throw error;
      }
      if (result.ready) {
        const poster = renderPoster(wallet, result.snapshot, '');
        await thread.send({ content: formatReport(wallet, result.snapshot, ''), files: [{ attachment: poster, name: 'wallet-report.png' }] });
        await status.edit('已完成：文字報表與 PNG 海報已傳到此討論串。');
        return;
      }
      if (result.waiting) { await status.edit('這個錢包正由其他查詢處理，請稍後再試。'); return; }
      const p = result.progress;
      await status.edit(p ? `本次掃描已處理至區塊 ${p.through} / ${p.target}；進度已保存，稍後可再次使用指令繼續。`
        : '本次掃描尚未取得進度，請稍後再試。');
    } catch (error) {
      let detail = String(error.message || 'Unknown error');
      for (const key of ['ALCHEMY_API_KEY', 'DATABASE_URL', 'DISCORD_TOKEN', 'ETHERSCAN_API_KEY']) {
        const secret = process.env[key];
        if (secret) detail = detail.split(secret).join('[redacted]');
      }
      detail = detail.replace(/(?:https?|postgres(?:ql)?):\/\/\S+/gi, '[redacted-url]');
      detail = detail.replace(/password\s*[=:]\s*\S+/gi, 'password=[redacted]');
      console.error('錢包查詢失敗', error.code || error.name, detail.slice(0, 300));
      const message = failedWallets.has(wallet)
        ? '錢包掃描未完成。為避免重複消耗 API，這個錢包暫停掃描至 UTC 零點；若先前有保存進度，會從保存的位置繼續。'
        : '錢包查詢未完成，請稍後再試；若已有保存的掃描進度，將從上次進度繼續。';
      if (status) await status.edit(message).catch(() => {});
      else if (interaction.replied) await interaction.editReply(message).catch(() => {});
      else await interaction.reply({ content: message }).catch(() => {});
    } finally { if (ownsBusy) busy = false; }
  };
}
