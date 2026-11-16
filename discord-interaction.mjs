import { MessageFlags } from 'discord.js';

export function createWalletHandler({ readPage, readSnapshot, reserveScan, renderPoster, formatReport, configured }) {
  let busy = false;
  return async interaction => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== 'wallet') return;
    const wallet = interaction.options.getString('address', true).trim().toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(wallet)) {
      await interaction.reply({ content: '請輸入有效的 Base 錢包地址（0x 開頭，後接 40 個十六進位字元）。', flags: MessageFlags.Ephemeral }); return;
    }
    if (!configured()) {
      await interaction.reply({ content: '機器人已連線，但錢包資料來源尚未完成設定，目前無法產生報表。', flags: MessageFlags.Ephemeral }); return;
    }
    if (busy) { await interaction.reply({ content: '目前有查詢進行中，請稍後再試。', flags: MessageFlags.Ephemeral }); return; }
    busy = true;
    try {
      await interaction.reply({ content: '已收到，正在檢查已儲存的報表；首次掃描會受每日用量上限保護。', flags: MessageFlags.Ephemeral });
      const cached = await readSnapshot(wallet);
      if (cached) {
        const note = '顯示已儲存的摘要，未自動查詢最新區塊。';
        const poster = renderPoster(wallet, cached, note);
        await interaction.editReply({ content: formatReport(wallet, cached, note), files: [{ attachment: poster, name: 'wallet-report.png' }] });
        return;
      }
      await interaction.editReply('找不到已儲存報表，正在背景掃描歷史資料；本次消耗設有上限，請稍候。');
      for (let i = 0; i < 4; i++) {
        if (!await reserveScan()) {
          await interaction.editReply('今日背景掃描額度已用完；已完成的進度會保留，請於 UTC 零點後再試。'); return;
        }
        const result = await readPage(wallet);
        if (result.ready) {
          const poster = renderPoster(wallet, result.snapshot, '');
          await interaction.editReply({ content: formatReport(wallet, result.snapshot, ''), files: [{ attachment: poster, name: 'wallet-report.png' }] }); return;
        }
        if (result.waiting) {
          await interaction.editReply('這個錢包正由其他查詢處理，請稍後再試。'); return;
        }
        const p = result.progress;
        await interaction.editReply(p ? `背景掃描進行中：區塊 ${p.through} / ${p.target}。已完成的進度會保存。` : '背景掃描進行中，請稍候。');
      }
      await interaction.editReply('本次背景掃描已達用量上限；已完成的進度會保留，請稍後再試。');
    } catch (error) {
      let detail = String(error.message || 'Unknown error');
      for (const key of ['ALCHEMY_API_KEY', 'DATABASE_URL', 'DISCORD_TOKEN', 'ETHERSCAN_API_KEY']) {
        const secret = process.env[key];
        if (secret) detail = detail.split(secret).join('[redacted]');
      }
      detail = detail.replace(/(?:https?|postgres(?:ql)?):\/\/\S+/gi, '[redacted-url]');
      detail = detail.replace(/password\s*[=:]\s*\S+/gi, 'password=[redacted]');
      console.error('錢包查詢失敗', error.code || error.name, detail.slice(0, 300));
      const message = '錢包查詢未完成，請稍後再試；若已有保存的掃描進度，將從上次進度繼續。';
      if (interaction.deferred || interaction.replied) await interaction.editReply(message).catch(() => {});
      else await interaction.reply({ content: message, flags: MessageFlags.Ephemeral }).catch(() => {});
    } finally { busy = false; }
  };
}
