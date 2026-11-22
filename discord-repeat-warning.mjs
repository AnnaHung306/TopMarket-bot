// Private moderator test only. No messages are removed and no roles are changed.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const GUILD_ID = '1541304826674155550';
const CHANNEL_ID = '1572821315507855430';
const WINDOW_MS = 30_000;
const COOLDOWN_MS = 300_000;
const MAX_ENTRIES = 1000;

const assets = JSON.parse(readFileSync(new URL('./assets/repeat-warning/manifest.json', import.meta.url), 'utf8'));
if (assets.length !== 2 || assets.some(a => !/^\d{2}\.gif$/u.test(a.file))) throw Error('Repeat warning GIF manifest invalid');
export function createRepeatWarningHandler({ canAct = async () => true, recordDetection, now = Date.now, random = Math.random } = {}) {
  if (typeof recordDetection !== 'function') throw Error('Repeat detection storage is required');
  const records = new Map();
  const cooldowns = new Map();
  const saving = new Set();
  return async message => {
    if (message.guildId !== GUILD_ID || message.channelId !== CHANNEL_ID || message.author?.bot ||
        message.webhookId || message.system || !/^\d{1,20}$/u.test(message.author?.id || '') ||
        typeof message.content !== 'string') return;
    const content = message.content.trim();
    if (!content) return;
    const time = now();
    for (const [key, item] of records) if (time - item.last >= WINDOW_MS) records.delete(key);
    for (const [key, until] of cooldowns) if (time >= until) cooldowns.delete(key);
    const key = JSON.stringify([message.author.id, content]);
    const previous = records.get(key);
    const times = (previous?.times || []).filter(t => time - t < WINDOW_MS);
    times.push(time);
    records.delete(key);
    records.set(key, { times, last: time });
    if (records.size > MAX_ENTRIES) records.delete(records.keys().next().value);
    if (times.length < 5 || cooldowns.has(message.author.id) || saving.has(message.author.id)) return;
    saving.add(message.author.id);
    try {
    if (!await canAct()) return;
    const counts = await recordDetection({ messageId: message.id, guildId: message.guildId, channelId: message.channelId, userId: message.author.id, detectedAt: time });
    if (!['total','giveaway','quiz'].every(key => Number.isSafeInteger(counts?.[key]) && counts[key] >= 0) || counts.total < 1) throw Error('Invalid repeat detection count');
    if (!await canAct()) return;
    cooldowns.set(message.author.id, time + COOLDOWN_MS);
    await message.channel.send({
      content: `🔎 疑似刷頻，待 MOD 審核\n用戶：<@${message.author.id}>\nGiveaway 排程時間窗 <t:${Math.floor(counts.giveawayWindow.start/1000)}:F> 至 <t:${Math.floor(counts.giveawayWindow.end/1000)}:F>：${counts.giveaway} 次\n答題排程時間窗 <t:${Math.floor(counts.quizWindow.start/1000)}:F> 至 <t:${Math.floor(counts.quizWindow.end/1000)}:F>：${counts.quiz} 次\n歷次偵測：${counts.total} 次（包含本次）\n以上依排程時間統計，未確認活動是否實際開場；疑似偵測不代表已確認違規。\n[查看觸發訊息](https://discord.com/channels/${message.guildId}/${message.channelId}/${message.id})`,
      allowedMentions: { parse: [] },
    });
    try {
      const selected = assets[Math.floor(random() * assets.length)];
      await message.reply({ content: `<@${message.author.id}> 請不要刷頻，謝謝喵，參加活動不可刷次數！\n (多次違反者將會被 mod 禁言)`,
        allowedMentions: { parse: [], users: [message.author.id], repliedUser: false },
        files: [{ attachment: fileURLToPath(new URL(`./assets/repeat-warning/${selected.file}`, import.meta.url)), name: `police-cat-${selected.file}` }] });
    } catch (error) { console.error('Repeat warning failed:', error.message); }
    } catch (error) { console.error('Repeat detection storage failed:', error.message); }
    finally { saving.delete(message.author.id); }
  };
}
