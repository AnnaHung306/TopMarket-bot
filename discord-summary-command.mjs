import { currentTaipeiPeriod, formatPeriod, readDay, requestSummary, resolveSpeakerNames, speakerMarkdownChunks, splitSummary } from './discord-daily-summary.mjs';

const GUILD = '1541304826674155550';
const SOURCE = '1548950663008878683';
const DESTINATION = '1572821315507855430';
const MOD_ROLE = '1571738627460038736';

// The command is only accepted from a Mod in the private test channel.
export function createSummaryCommand({ client, apiKey, model, canAct, fetchImpl, now = Date.now }) {
  let running = false;
  return async message => {
    if (message.guildId !== GUILD || message.channelId !== DESTINATION || message.author?.bot || message.webhookId || message.content?.trim() !== '!聊天摘要') return;
    if (!message.member?.roles?.cache?.has(MOD_ROLE) || !await canAct()) return;
    if (running) {
      await message.channel.send({ content: '目前已有摘要查詢進行中，請稍後再試。', allowedMentions: { parse: [] } });
      return;
    }
    running = true;
    try {
      const period = currentTaipeiPeriod(now());
      const guild = await client.guilds.fetch(GUILD);
      const source = await guild.channels.fetch(SOURCE);
      if (!source?.messages || source.id !== SOURCE) throw Error('SUMMARY_CHANNEL_UNAVAILABLE');
      const { messages, speakers, totalHuman } = await readDay(source, period.start, period.end);
      const namedSpeakers = await resolveSpeakerNames(guild, messages, speakers);
      if (!await canAct()) throw Error('SUMMARY_LOCK_LOST');
      const result = await requestSummary(messages, { apiKey, model, fetchImpl });
      const parts = splitSummary(result);
      const chunks = speakerMarkdownChunks(namedSpeakers);
      if (!parts.length) throw Error('SUMMARY_OUTPUT_INVALID');
      if (!await canAct()) throw Error('SUMMARY_LOCK_LOST');
      await message.channel.send({ content: `📝 #chinese 即時摘要草稿\n統計期間：${formatPeriod(period)}\n訊息 ${totalHuman} 則、發言人 ${speakers.length} 位。請 MOD 核對原始訊息後再使用。`, embeds: [{ description: parts[0] }], allowedMentions: { parse: [], repliedUser: false } });
      for (const part of parts.slice(1)) {
        if (!await canAct()) throw Error('SUMMARY_LOCK_LOST');
        await message.channel.send({ content: '📝 #chinese 即時聊天重點（續）', embeds: [{ description: part }], allowedMentions: { parse: [], repliedUser: false } });
      }
      for (const chunk of chunks) {
        if (!await canAct()) throw Error('SUMMARY_LOCK_LOST');
        await message.channel.send({ content: `📝 #chinese 即時發言次數\n${chunk}`, allowedMentions: { parse: [], repliedUser: false } });
      }
    } catch (error) {
      console.error('Private summary command failed:', error.message);
      if (await canAct()) await message.channel.send({ content: '⚠️ 即時摘要未完成，請 MOD 檢查服務紀錄；若已有部分內容，請勿視為完整報告。', allowedMentions: { parse: [] } }).catch(() => {});
    } finally { running = false; }
  };
}
