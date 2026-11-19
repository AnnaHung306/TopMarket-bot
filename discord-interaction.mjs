import { MessageFlags, ThreadAutoArchiveDuration } from 'discord.js';
import { readFile } from 'node:fs/promises';
import { randomInt } from 'node:crypto';

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

export function createWalletHandler({ queryWallet, renderPoster, formatReport, configured, chooseWaitingIndex = randomInt }) {
  return async interaction => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== 'wallet') return;
    const startedAt = performance.now();
    const inThread = interaction.channel?.isThread?.() ?? false;
    const allowedChannel = process.env.DISCORD_WALLET_CHANNEL_ID?.trim();
    const inToolbox = interaction.channelId === allowedChannel ||
      (inThread && interaction.channel.parentId === allowedChannel);
    if (allowedChannel && !inToolbox) {
      await interaction.reply({ content: '請在指定的 MOD 工具箱頻道或其討論串使用此指令。', flags: MessageFlags.Ephemeral });
      return;
    }
    const wallet = interaction.options.getString('address', true).trim().toLowerCase();
    let status, thread;
    let stage = 'discord_setup';
    try {
      await interaction.deferReply();
      if (inThread) {
        thread = interaction.channel;
        await interaction.editReply({ content: waitingText });
      } else {
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
      }
      try {
        status = await thread.send('正在核對錢包收支，完成後會在此通知。');
      }
      catch (error) {
        console.error('無法在錢包討論串回覆', error.code || error.name);
        await interaction.editReply('機器人無法在討論串內回覆。請確認「在討論串傳送訊息」及「附加檔案」權限。');
        return;
      }
      if (!validWallet(wallet)) {
        await status.edit('請輸入有效的 Base 錢包地址（0x 開頭，後接 40 個十六進位字元）。'); return;
      }
      if (!configured()) {
        await status.edit('機器人已連線，但錢包資料來源尚未完成設定，目前無法產生報表。'); return;
      }
      stage = 'query';
      const queryStart = performance.now();
      const { snapshot, usage, pages, queryId } = await queryWallet(wallet, interaction.id);
      const posterStart = performance.now();
      console.info('wallet_query', JSON.stringify({
        interaction_id: interaction.id, query_ms: Math.round(posterStart - queryStart),
        query_id: queryId, estimated_cu: usage.units, rpc_http_requests: usage.requests,
        rpc_retries: usage.retries, log_splits: usage.splits, scan_pages: pages,
      }));
      stage = 'poster';
      const poster = await renderPoster(wallet, snapshot);
      const uploadStart = performance.now();
      stage = 'discord_upload';
      await thread.send({
        content: `拍拍 <@${interaction.user.id}>\n${formatReport(wallet, snapshot)}`,
        allowedMentions: { users: [interaction.user.id] },
        files: [{ attachment: poster, name: 'wallet-report.png' }],
      });
      const deliveredAt = performance.now();
      console.info('wallet_delivery', JSON.stringify({
        interaction_id: interaction.id, poster_ms: Math.round(uploadStart - posterStart),
        upload_ms: Math.round(deliveredAt - uploadStart), total_ms: Math.round(deliveredAt - startedAt),
      }));
      await status.edit('已完成：文字報表與 PNG 海報已傳到此討論串。')
        .catch(error => console.error('無法更新完成狀態', error.code || error.name));
    } catch (error) {
      console.error('錢包查詢失敗', { stage, interaction_id: interaction.id, elapsed_ms: Math.round(performance.now() - startedAt) },
        error.code || error.name, safeError(error));
      const message = stage === 'query'
        ? '暫時無法完成鏈上查詢。請稍後再試，已保存的查詢進度可繼續使用。'
        : '暫時無法傳送錢包報表。請稍後再試。';
      if (status) await status.edit(message).catch(() => {});
      else if (interaction.replied || interaction.deferred) await interaction.editReply(message).catch(() => {});
      else await interaction.reply({ content: message }).catch(() => {});
    }
  };
}
