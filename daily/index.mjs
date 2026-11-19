import { randomInt, createHash } from 'node:crypto';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { dateKey, midnight, eventTimes, isActivityDay } from './time.mjs';
import { hasMessages } from './eligibility.mjs';
import { createGiveawayQualification } from './giveaway-qualification.mjs';
export { eventTimes } from './time.mjs';

const EPHEMERAL = MessageFlags.Ephemeral;
const DAY = 86400000;
const snowflake = /^\d{17,20}$/;
const nonceFor = value => createHash('sha256').update(value).digest('hex').slice(0, 24);
const ids = (name, value) => { if (!snowflake.test(value || '')) throw Error(`${name} must be a Discord ID`); return value; };
const command = new SlashCommandBuilder().setName('dailyquiz').setDescription('管理每日答題題目')
  .addSubcommand(s => s.setName('add').setDescription('預先設定指定日期的題目')
    .addStringOption(o => o.setName('date').setDescription('台灣時間日期 YYYY-MM-DD').setRequired(true))
    .addStringOption(o => o.setName('question').setDescription('題目').setMaxLength(500).setRequired(true))
    .addStringOption(o => o.setName('a').setDescription('選項 A').setMaxLength(80).setRequired(true))
    .addStringOption(o => o.setName('b').setDescription('選項 B').setMaxLength(80).setRequired(true))
    .addStringOption(o => o.setName('c').setDescription('選項 C').setMaxLength(80).setRequired(true))
    .addStringOption(o => o.setName('d').setDescription('選項 D').setMaxLength(80).setRequired(true))
    .addStringOption(o => o.setName('correct').setDescription('正確答案').setRequired(true).addChoices(...['A','B','C','D'].map(x => ({ name:x, value:x })))));

export function createDailyModule({ client, sql, env = process.env, now = Date.now, logger = console }) {
  const guildId = ids('DAILY_GUILD_ID', env.DAILY_GUILD_ID);
  const channelId = ids('DAILY_CHANNEL_ID', env.DAILY_CHANNEL_ID);
  const groupCategoryId = ids('DAILY_GROUP_CATEGORY_ID', env.DAILY_GROUP_CATEGORY_ID);
  const groupChannelIds = (env.DAILY_GROUP_CHANNEL_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!groupChannelIds.length || new Set(groupChannelIds).size !== groupChannelIds.length) throw Error('DAILY_GROUP_CHANNEL_IDS invalid');
  for (const id of groupChannelIds) ids('DAILY_GROUP_CHANNEL_IDS', id);
  const moderatorRoleId = ids('DAILY_MODERATOR_ROLE_ID', env.DAILY_MODERATOR_ROLE_ID);
  const botRoleId = ids('DAILY_BOT_ROLE_ID', env.DAILY_BOT_ROLE_ID);
  const giveawayBoatId = ids('DAILY_GIVEAWAY_BOAT_ID', env.DAILY_GIVEAWAY_BOAT_ID);
  const giveawayQualification = env.DAILY_GIVEAWAY_TEST_ENABLED === 'true' ? createGiveawayQualification({
    guildId, roleId: env.DAILY_GIVEAWAY_ROLE_ID, testerId: env.DAILY_GIVEAWAY_TEST_USER_ID,
    channelIds: groupChannelIds, categoryId: groupCategoryId, client, sql, now,
  }) : null;
  let timer, ticking = false;
  const locks = new Map();
  async function locked(key, task) {
    const previous = locks.get(key) || Promise.resolve();
    let release;
    const next = new Promise(resolve => { release = resolve; });
    locks.set(key, next);
    await previous;
    try { return await task(); }
    finally { release(); if (locks.get(key) === next) locks.delete(key); }
  }
  async function initialize() {
    await sql`CREATE TABLE IF NOT EXISTS daily_quiz_questions (day text PRIMARY KEY, question text NOT NULL, options jsonb NOT NULL, correct text NOT NULL, created_by text NOT NULL)`;
    await sql`CREATE TABLE IF NOT EXISTS daily_events (day text NOT NULL, kind text NOT NULL, question text, options jsonb, correct text, message_id text, result jsonb, result_message_id text, PRIMARY KEY(day, kind))`;
    await sql`CREATE TABLE IF NOT EXISTS daily_entries (day text NOT NULL, kind text NOT NULL, user_id text NOT NULL, answer text, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(day, kind, user_id), FOREIGN KEY(day,kind) REFERENCES daily_events(day,kind))`;
  }
  async function guildAndChannel() {
    const guild = await client.guilds.fetch(guildId);
    const channel = await guild.channels.fetch(channelId);
    if (!channel || channel.type !== ChannelType.GuildText) throw Error('DAILY_CHANNEL_INVALID');
    if (!channel.permissionsFor(guild.members.me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory])) throw Error('DAILY_CHANNEL_PERMISSIONS_MISSING');
    // The test channel must stay private until the user explicitly releases it.
    const everyone = channel.permissionOverwrites.cache.get(guild.id);
    const moderator = channel.permissionOverwrites.cache.get(moderatorRoleId);
    if (!everyone?.deny.has(PermissionFlagsBits.ViewChannel) || !moderator?.allow.has(PermissionFlagsBits.ViewChannel)) throw Error('DAILY_PRIVATE_CHANNEL_REQUIRED');
    for (const overwrite of channel.permissionOverwrites.cache.values()) {
      if (![moderatorRoleId, botRoleId, client.user.id, giveawayBoatId].includes(overwrite.id) && overwrite.allow.has(PermissionFlagsBits.ViewChannel)) throw Error('DAILY_PRIVATE_CHANNEL_EXTRA_ACCESS');
    }
    return { guild, channel };
  }
  // Reconstruct counts from the actual message history at admission, so reconnects
  // do not silently lose messages. Never store or inspect message contents.
  async function eligible(guild, userId, required, time, start) {
    return hasMessages({ guild, channelIds: groupChannelIds, categoryId: groupCategoryId, userId, start, end: time, required });
  }
  function buttons(day, kind, disabled = false) {
    const labels = ['A','B','C','D'];
    return [new ActionRowBuilder().addComponents(...labels.map((label, i) => new ButtonBuilder()
      .setCustomId(`daily:${kind}:${day}:${label}`)
      .setLabel(label).setStyle(i === 0 ? ButtonStyle.Primary : ButtonStyle.Secondary).setDisabled(disabled)))];
  }
  function content(event) {
    const end = Math.floor(eventTimes(event.day, event.kind).end / 1000);
    return `📝 **每日答題**\n${event.question}\n${event.options.map((x,i) => `${'ABCD'[i]}. ${x}`).join('\n')}\n獎項：2U × 2 名；今日 group chat 發言滿 10 次可參加。\n每人只能回答一次，無法修改。截止：<t:${end}:F>`;
  }
  async function send(channel, payload, key) {
    // Recover a successful Discord send if the process stopped before its ID
    // reached PostgreSQL. Discord nonce deduplication alone only lasts minutes.
    const day = key.split(':').at(-1);
    const since = midnight(day) - DAY;
    let before;
    for (let pageNo = 0; ; pageNo++) {
      if (pageNo >= 100) throw Error('DAILY_MESSAGE_RECOVERY_LIMIT');
      const page = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
      const match = [...page.values()].find(m => m.author?.id === client.user.id && m.content === payload.content);
      if (match) return match;
      if (page.size < 100 || Math.min(...[...page.values()].map(m => m.createdTimestamp)) < since) break;
      before = page.last().id;
    }
    return channel.send({ ...payload, nonce: nonceFor(key), enforceNonce: true, allowedMentions: payload.allowedMentions || { parse: [] } });
  }
  async function open(day, kind, channel) {
    if (kind === 'quiz') {
      const [q] = await sql`SELECT * FROM daily_quiz_questions WHERE day=${day}`;
      if (!q) {
        // Same nonce avoids repeated notifications while Discord's deduplication window applies.
        await sql`INSERT INTO daily_events(day,kind,result) VALUES (${day}, 'missing', '{"missing":true}'::jsonb) ON CONFLICT DO NOTHING`;
        const [notice] = await sql`SELECT message_id FROM daily_events WHERE day=${day} AND kind='missing'`;
        if (!notice.message_id) {
          const msg = await send(channel, { content: `<@&${moderatorRoleId}> ${day} 沒有預先設定答題題目，已跳過。`, allowedMentions: { roles: [moderatorRoleId] } }, `missing:${day}`);
          await sql`UPDATE daily_events SET message_id=${msg.id} WHERE day=${day} AND kind='missing'`;
        }
        return;
      }
      await sql`INSERT INTO daily_events(day,kind,question,options,correct) VALUES (${day},${kind},${q.question},${JSON.stringify(q.options)}::jsonb,${q.correct}) ON CONFLICT DO NOTHING`;
    }
    const [event] = await sql`SELECT * FROM daily_events WHERE day=${day} AND kind=${kind}`;
    if (!event.message_id) {
      const message = await send(channel, { content: content(event), components: buttons(day, kind) }, `open:${kind}:${day}`);
      await sql`UPDATE daily_events SET message_id=${message.id} WHERE day=${day} AND kind=${kind} AND message_id IS NULL`;
    }
  }
  async function close(event, channel) {
    if (!event.result) {
      const entries = await sql`SELECT user_id FROM daily_entries WHERE day=${event.day} AND kind='quiz' AND answer=${event.correct} ORDER BY user_id`;
      const candidates = entries.map(x => x.user_id), winners = [];
      while (candidates.length && winners.length < 2) winners.push(candidates.splice(randomInt(candidates.length), 1)[0]);
      const result = { winners, candidates: entries.length };
      const [stored] = await sql`UPDATE daily_events SET result=${JSON.stringify(result)}::jsonb WHERE day=${event.day} AND kind=${event.kind} AND result IS NULL RETURNING result`;
      if (stored) event.result = stored.result;
      else [event] = await sql`SELECT * FROM daily_events WHERE day=${event.day} AND kind=${event.kind}`;
    }
    if (!event.result_message_id) {
      const title = '每日答題';
      const winners = event.result.winners.map(id => `<@${id}>`).join('、') || '無';
      const answer = `\n正確答案：${event.correct}`;
      const msg = await send(channel, { content: `🏆 **${event.day} ${title}結果**${answer}\n得獎者：${winners}\n獎項：每人 2U；未產生名額：${2-event.result.winners.length}。請等待 MOD 發放。` }, `result:${event.kind}:${event.day}`);
      await sql`UPDATE daily_events SET result_message_id=${msg.id} WHERE day=${event.day} AND kind=${event.kind} AND result_message_id IS NULL`;
    }
    if (event.message_id) {
      const message = await channel.messages.fetch(event.message_id);
      await message.edit({ components: buttons(event.day, event.kind, true) });
    }
  }
  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      const { channel } = await guildAndChannel();
      if (giveawayQualification) {
        try { await giveawayQualification.tick(); }
        catch (error) { logger.error('DAILY_GIVEAWAY_QUALIFICATION_FAILED', error); }
      }
      const time = now();
      for (const event of await sql`SELECT * FROM daily_events WHERE kind = 'quiz' AND (result_message_id IS NULL OR result IS NULL)`) {
        if (time >= eventTimes(event.day,event.kind).end) await locked(`${event.kind}:${event.day}`, () => close(event, channel));
      }
      for (const day of [dateKey(time-DAY),dateKey(time)]) for (const kind of ['quiz']) {
        if (!isActivityDay(day)) continue;
        const { start,end } = eventTimes(day,kind);
        if (time >= start && time < end) await open(day,kind,channel);
      }
    } catch (error) { logger.error('DAILY_TICK_FAILED', error); }
    finally { ticking = false; }
  }
  async function handle(interaction) {
    if (interaction.guildId !== guildId) return;
    if (interaction.isChatInputCommand() && interaction.commandName === 'dailyquiz') {
      if (!interaction.member?.roles?.cache?.has(moderatorRoleId)) return interaction.reply({ content:'只有 MOD 可設定題目。', flags:EPHEMERAL });
      if (interaction.channelId !== channelId) return interaction.reply({content:'請在指定私人頻道設定題目。',flags:EPHEMERAL});
      const opts = interaction.options, day = opts.getString('date',true);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(midnight(day)) || dateKey(midnight(day)) !== day || !isActivityDay(day) || now() >= eventTimes(day,'quiz').start)
        return interaction.reply({content:'日期無效、為週末，或該日期的出題時間已到。',flags:EPHEMERAL});
      const options = ['a','b','c','d'].map(k => opts.getString(k,true));
      await sql`INSERT INTO daily_quiz_questions(day,question,options,correct,created_by) VALUES (${day},${opts.getString('question',true)},${JSON.stringify(options)}::jsonb,${opts.getString('correct',true)},${interaction.user.id}) ON CONFLICT(day) DO UPDATE SET question=excluded.question,options=excluded.options,correct=excluded.correct,created_by=excluded.created_by`;
      return interaction.reply({content:`已設定 ${day} 的每日題目，正確答案不會公開。`,flags:EPHEMERAL});
    }
    if (!interaction.isButton() || !interaction.customId.startsWith('daily:')) return;
    const [,kind,day,answer] = interaction.customId.split(':');
    if (kind !== 'quiz' || interaction.channelId !== channelId || !/^\d{4}-\d{2}-\d{2}$/.test(day) || !['A','B','C','D'].includes(answer)) return;
    await interaction.deferReply({flags:EPHEMERAL});
    const time = now(), {start,end} = eventTimes(day,kind);
    if (time < start || time >= end) return interaction.editReply('這場活動尚未開始或已截止。');
    const [event] = await sql`SELECT message_id,result FROM daily_events WHERE day=${day} AND kind=${kind}`;
    if (!event || event.result || event.message_id !== interaction.message.id) return interaction.editReply('活動已結束或無法確認，請聯絡 MOD。');
    const [existing] = await sql`SELECT 1 FROM daily_entries WHERE day=${day} AND kind=${kind} AND user_id=${interaction.user.id}`;
    if (existing) return interaction.editReply(kind === 'quiz' ? '你已經回答過，答案不能修改。' : '你已經參加過這場抽獎。');
    try {
      if (!await eligible(interaction.guild,interaction.user.id,10,time,start)) return interaction.editReply('目前尚未達到本場答題的發言門檻。');
      return await locked(`${kind}:${day}`, async () => {
        if (now() >= end) return interaction.editReply('活動已截止。');
        const [added] = await sql`INSERT INTO daily_entries(day,kind,user_id,answer) SELECT ${day},${kind},${interaction.user.id},${kind === 'quiz' ? answer : null} WHERE EXISTS (SELECT 1 FROM daily_events WHERE day=${day} AND kind=${kind} AND result IS NULL) ON CONFLICT DO NOTHING RETURNING user_id`;
        return interaction.editReply(added ? (kind === 'quiz' ? `已提交答案 ${answer}，本場不能修改。` : '已成功參加抽獎。') : '你已參加或活動已結束。');
      });
    } catch (error) { logger.error('DAILY_ELIGIBILITY_FAILED',error); return interaction.editReply('目前無法驗證發言資格，請稍後重試或聯絡 MOD。'); }
  }
  return { guildId, commands:[command.toJSON()], handle, tick, async start() { await initialize(); if (giveawayQualification) await giveawayQualification.initialize(); await tick(); timer = setInterval(tick, 30000); }, stop() { clearInterval(timer); } };
}
