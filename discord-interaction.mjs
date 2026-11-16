import { MessageFlags } from 'discord.js';

export function createWalletHandler({ readPage, getReport, renderPoster, formatReport, configured }) {
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
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      let lastUpdate = 0;
      const update = async message => {
        if (Date.now() - lastUpdate > 10000) { lastUpdate = Date.now(); await interaction.editReply(message); }
      };
      const { snapshot, note } = await getReport(wallet, readPage, update);
      const poster = renderPoster(wallet, snapshot, note);
      await interaction.editReply({ content: formatReport(wallet, snapshot, note), files: [{ attachment: poster, name: 'wallet-report.png' }] });
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
