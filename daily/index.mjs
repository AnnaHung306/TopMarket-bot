import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { dateKey, midnight, eventTimes, isActivityDay, reportTime } from './time.mjs';
import { activityRules } from './activity-rules.mjs';
import { hasMessages } from './eligibility.mjs';
import { initializeSnapshots, pruneSnapshots, refreshScheduledSnapshots, eligibleWithSnapshot } from './message-snapshot.mjs';
import { createGiveawayQualification } from './giveaway-qualification.mjs';
import { createMemberGiveawayQualification } from './giveaway-members.mjs';
import { giveawayTrackCommand, registerGiveaway } from './giveaway-registration.mjs';
import { drawWinners } from './draw.mjs';
import { mayManageActivity, cancelCommand } from './moderator-access.mjs';
import { recordCancellation, removeGiveawayRole } from './moderation-cancellation.mjs';
import { quizParticipantIncidents, reviewPages } from './participant-review.mjs';
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
const reviewCommand = new SlashCommandBuilder().setName('activity-review').setDescription('查看本場參賽者的疑似刷頻統計（僅 MOD）')
  .setDefaultMemberPermissions(0)
  .addStringOption(o => o.setName('activity').setDescription('活動').setRequired(true)
    .addChoices({ name:'每日答題', value:'quiz' }, { name:'Giveaway', value:'giveaway' }));

export function createDailyModule({ client, sql, incidentSql = sql, env = process.env, now = Date.now, logger = console, privateTestChannelId = null, privateTestStart = null }) {
  const guildId = ids('DAILY_GUILD_ID', env.DAILY_GUILD_ID);
  const channelId = ids('DAILY_CHANNEL_ID', env.DAILY_CHANNEL_ID);
  const modChannelId = ids('DAILY_MOD_CHANNEL_ID', env.DAILY_MOD_CHANNEL_ID);
  if (privateTestChannelId && (privateTestChannelId !== modChannelId || privateTestChannelId !== channelId)) throw Error('DAILY_TEST_CHANNEL_INVALID');
  if (privateTestStart !== null && (!privateTestChannelId || !Number.isFinite(privateTestStart))) throw Error('DAILY_TEST_START_INVALID');
  const groupCategoryId = ids('DAILY_GROUP_CATEGORY_ID', env.DAILY_GROUP_CATEGORY_ID);
  const groupChannelIds = (env.DAILY_GROUP_CHANNEL_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (new Set(groupChannelIds).size !== groupChannelIds.length) throw Error('DAILY_GROUP_CHANNEL_IDS invalid');
  for (const id of groupChannelIds) ids('DAILY_GROUP_CHANNEL_IDS', id);
  const moderatorRoleId = ids('DAILY_MODERATOR_ROLE_ID', env.DAILY_MODERATOR_ROLE_ID);
  const botRoleId = ids('DAILY_BOT_ROLE_ID', env.DAILY_BOT_ROLE_ID);
  const giveawayBoatId = ids('DAILY_GIVEAWAY_BOAT_ID', env.DAILY_GIVEAWAY_BOAT_ID);
  const snapshotsEnabled = env.DAILY_SNAPSHOT_ENABLED === 'true';
  const memberGiveawayEnabled = env.DAILY_GIVEAWAY_ENABLED === 'true';
  if (memberGiveawayEnabled && env.DAILY_GIVEAWAY_TEST_ENABLED === 'true') throw Error('DAILY_GIVEAWAY_MODES_CONFLICT');
  const giveawayQualification = memberGiveawayEnabled ? createMemberGiveawayQualification({
    guildId,roleId:env.DAILY_GIVEAWAY_ROLE_ID,boatId:giveawayBoatId,channelId,categoryId:groupCategoryId,client,sql,now,onlyChannelId:privateTestChannelId,
  }) : env.DAILY_GIVEAWAY_TEST_ENABLED === 'true' ? createGiveawayQualification({
    guildId, roleId: env.DAILY_GIVEAWAY_ROLE_ID, testerId: env.DAILY_GIVEAWAY_TEST_USER_ID, boatId:giveawayBoatId, testChannelId:modChannelId,
    channelIds: groupChannelIds, categoryId: groupCategoryId, client, sql, now,
    checkEligibility: ({guild,userId,start,end,required}) => eligible(guild,userId,required,end,start),
  }) : null;
  let timer, ticking = false, lastSnapshotPruneDay = null;
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
    await sql`ALTER TABLE daily_events ADD COLUMN IF NOT EXISTS mod_result_message_id text`;
    await sql`ALTER TABLE daily_events ADD COLUMN IF NOT EXISTS mod_notice jsonb`;
    await sql`ALTER TABLE daily_events ADD COLUMN IF NOT EXISTS review_notice jsonb`;
    await sql`CREATE TABLE IF NOT EXISTS daily_review_notice_pages (day text NOT NULL, kind text NOT NULL, page integer NOT NULL, message_id text NOT NULL, PRIMARY KEY(day,kind,page))`;
    await sql`CREATE TABLE IF NOT EXISTS daily_mod_notice_pages (day text NOT NULL, kind text NOT NULL, page integer NOT NULL, message_id text NOT NULL, PRIMARY KEY(day,kind,page))`;
    await sql`CREATE TABLE IF NOT EXISTS daily_settings (key text PRIMARY KEY, value text NOT NULL)`;
    await sql`CREATE TABLE IF NOT EXISTS daily_disqualifications (day text NOT NULL, kind text NOT NULL, user_id text NOT NULL, moderator_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(day,kind,user_id))`;
    await sql`INSERT INTO daily_settings(key,value) VALUES ('mod_notice_start_day',${dateKey(now()-DAY)}) ON CONFLICT(key) DO NOTHING`;
    await sql`CREATE TABLE IF NOT EXISTS daily_entries (day text NOT NULL, kind text NOT NULL, user_id text NOT NULL, answer text, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(day, kind, user_id), FOREIGN KEY(day,kind) REFERENCES daily_events(day,kind))`;
    await sql`CREATE TABLE IF NOT EXISTS daily_quiz_bank (id text PRIMARY KEY, question text NOT NULL, options jsonb NOT NULL, correct text NOT NULL, assigned_day text UNIQUE)`;
    if (snapshotsEnabled) await initializeSnapshots(sql);
    const bank = JSON.parse(await readFile(new URL('./pokemon-question-bank.json', import.meta.url), 'utf8'));
    if (!Array.isArray(bank) || !bank.length || bank.some(q => !q.id || !q.question || !Array.isArray(q.options) || q.options.length !== 4 || !['A','B','C','D'].includes(q.correct))) throw Error('DAILY_QUESTION_BANK_INVALID');
    await sql`INSERT INTO daily_quiz_bank(id,question,options,correct) SELECT id,question,options,correct FROM jsonb_to_recordset(${JSON.stringify(bank)}::jsonb) AS item(id text,question text,options jsonb,correct text) ON CONFLICT(id) DO NOTHING`;
  }
  async function guildAndChannel() {
    const guild = await client.guilds.fetch(guildId);
    const channel = await guild.channels.fetch(channelId);
    const modChannel = await guild.channels.fetch(modChannelId);
    if (!channel || channel.type !== ChannelType.GuildText) throw Error('DAILY_CHANNEL_INVALID');
    if (!modChannel || modChannel.type !== ChannelType.GuildText) throw Error('DAILY_MOD_CHANNEL_INVALID');
    if (!modChannel.permissionsFor(guild.members.me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory])) throw Error('DAILY_MOD_CHANNEL_PERMISSIONS_MISSING');
    if (!modChannel.permissionOverwrites.cache.get(guild.id)?.deny.has(PermissionFlagsBits.ViewChannel) || !modChannel.permissionOverwrites.cache.get(moderatorRoleId)?.allow.has(PermissionFlagsBits.ViewChannel)) throw Error('DAILY_PRIVATE_MOD_CHANNEL_REQUIRED');
    if (!channel.permissionsFor(guild.members.me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory])) throw Error('DAILY_CHANNEL_PERMISSIONS_MISSING');
    // The test channel must stay private until the user explicitly releases it.
    const everyone = channel.permissionOverwrites.cache.get(guild.id);
    const moderator = channel.permissionOverwrites.cache.get(moderatorRoleId);
    if (!everyone?.deny.has(PermissionFlagsBits.ViewChannel) || !moderator?.allow.has(PermissionFlagsBits.ViewChannel)) throw Error('DAILY_PRIVATE_CHANNEL_REQUIRED');
    for (const overwrite of channel.permissionOverwrites.cache.values()) {
      const allowed = [moderatorRoleId, botRoleId, client.user.id, giveawayBoatId];
      if (privateTestChannelId && giveawayQualification) allowed.push(env.DAILY_GIVEAWAY_TEST_USER_ID);
      if (!allowed.includes(overwrite.id) && overwrite.allow.has(PermissionFlagsBits.ViewChannel)) throw Error('DAILY_PRIVATE_CHANNEL_EXTRA_ACCESS');
    }
    return { guild, channel, modChannel };
  }
  // Reconstruct counts from the actual message history at admission, so reconnects
  // do not silently lose messages. Never store or inspect message contents.
  async function eligible(guild, userId, required, time, start) {
    const args={guild,categoryId:groupCategoryId,userId,start:privateTestStart === null ? start : Math.max(start,privateTestStart),end:time,required,onlyChannelId:privateTestChannelId};
    if (snapshotsEnabled) return eligibleWithSnapshot({...args,sql,day:dateKey(start)});
    return hasMessages(args);
  }
  function joinButton(day, kind, disabled = false) {
    return [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`daily:${kind}:${day}:join`).setLabel('參加答題').setStyle(ButtonStyle.Primary).setDisabled(disabled))];
  }
  function answerButtons(day, userId, messageId) {
    const labels = ['A','B','C','D'];
    return [new ActionRowBuilder().addComponents(...labels.map((label, i) => new ButtonBuilder()
      .setCustomId(`daily:quiz:${day}:answer:${userId}:${messageId}:${label}`)
      .setLabel(label).setStyle(i === 0 ? ButtonStyle.Primary : ButtonStyle.Secondary)))];
  }
  function content(event) {
    return `📝 **每日答題**\n${activityRules(event.day,'quiz')}\n\n**題目：**${event.question}\n點選「參加答題」並通過資格驗證後，選項會僅對你顯示。`;
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
      let [q] = await sql`SELECT * FROM daily_quiz_questions WHERE day=${day}`;
      if (!q) {
        [q] = await sql`SELECT * FROM daily_quiz_bank WHERE assigned_day=${day}`;
        if (!q) {
          try {
            [q] = await sql`UPDATE daily_quiz_bank SET assigned_day=${day} WHERE id=(SELECT id FROM daily_quiz_bank b WHERE b.assigned_day IS NULL AND NOT EXISTS (SELECT 1 FROM daily_events e WHERE e.kind='quiz' AND e.question=b.question) ORDER BY random() LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`;
          } catch (error) {
            if (error.code !== '23505') throw error;
            [q] = await sql`SELECT * FROM daily_quiz_bank WHERE assigned_day=${day}`;
          }
        }
      }
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
      const message = await send(channel, { content: content(event), components: joinButton(day, kind) }, `open:${kind}:${day}`);
      await sql`UPDATE daily_events SET message_id=${message.id} WHERE day=${day} AND kind=${kind} AND message_id IS NULL`;
    }
  }
  async function close(event, channel, modChannel) {
    if (!event.result) {
      const entries = await sql`SELECT user_id FROM daily_entries WHERE day=${event.day} AND kind='quiz' AND answer=${event.correct} ORDER BY user_id`;
      const winners = drawWinners(entries.map(x => x.user_id));
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
      await message.edit({ components: joinButton(event.day, event.kind, true) });
    }
    if (now() >= reportTime(event.day,event.kind) && !event.mod_result_message_id) {
      const winners = event.result.winners.map(id => `<@${id}>（Discord ID: ${id}）：2U`).join('\n') || '本場無得獎者';
      if (!event.mod_notice) {
        const {start, end} = eventTimes(event.day, event.kind);
        const incidents = await quizParticipantIncidents(sql, { guildId, day:event.day, start, end, incidentSql });
        const lines = incidents.map(x => `<@${x.user_id}>：${x.warnings} 次提示（${x.pending} 次待審核）`);
        if (!lines.length) lines.push('本場沒有疑似刷頻提示紀錄。');
        const pages = [`<@&${moderatorRoleId}> 🏆 **${event.day} 每日答題發獎清單**\n${winners}\n請提供並核對得獎者的 Discord 與綁定錢包資訊，再由 MOD 處理發獎。\n\n**疑似刷頻提示統計（供 MOD 審核，不自動取消資格）**`];
        for (const line of lines) {
          const last = pages.length - 1;
          if (pages[last].length + line.length + 1 > 1800) pages.push(`**${event.day} 疑似刷頻提示統計（續）**`);
          pages[pages.length - 1] += `\n${line}`;
        }
        const [saved] = await sql`UPDATE daily_events SET mod_notice=${JSON.stringify(pages)}::jsonb WHERE day=${event.day} AND kind=${event.kind} AND mod_notice IS NULL RETURNING mod_notice`;
        if (saved) event.mod_notice = saved.mod_notice;
        else [event] = await sql`SELECT * FROM daily_events WHERE day=${event.day} AND kind=${event.kind}`;
      }
      for (let page = 0; page < event.mod_notice.length; page++) {
        const [sent] = await sql`SELECT message_id FROM daily_mod_notice_pages WHERE day=${event.day} AND kind=${event.kind} AND page=${page}`;
        if (!sent) {
          const msg = await send(modChannel, { content: event.mod_notice[page], allowedMentions: { roles: page === 0 ? [moderatorRoleId] : [], users: [] } }, `mod-result:${page}:${event.kind}:${event.day}`);
          await sql`INSERT INTO daily_mod_notice_pages(day,kind,page,message_id) VALUES (${event.day},${event.kind},${page},${msg.id}) ON CONFLICT DO NOTHING`;
        }
      }
      const [first] = await sql`SELECT message_id FROM daily_mod_notice_pages WHERE day=${event.day} AND kind=${event.kind} AND page=0`;
      await sql`UPDATE daily_events SET mod_result_message_id=${first.message_id} WHERE day=${event.day} AND kind=${event.kind} AND mod_result_message_id IS NULL`;
    }
  }
  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      // This does not depend on Discord availability or activity days. Only a
      // successful transaction suppresses retries until the next Taiwan day.
      if (snapshotsEnabled) {
        const pruneTime = now(), today = dateKey(pruneTime);
        if (today !== lastSnapshotPruneDay) {
          try { await pruneSnapshots(sql,pruneTime); lastSnapshotPruneDay = today; }
          catch (error) { logger.error('DAILY_SNAPSHOT_RETENTION_FAILED',error); }
        }
      }
      const { guild, channel, modChannel } = await guildAndChannel();
      const time = now();
      for (const event of await sql`SELECT * FROM daily_events WHERE kind='quiz' AND result IS NULL AND message_id IS NOT NULL`) {
        const {start,end} = eventTimes(event.day,'quiz');
        if (time >= end - 15 * 60000 && time < end) {
          if (!event.review_notice) {
            const rows = await quizParticipantIncidents(sql, {guildId,day:event.day,start,end:time,incidentSql});
            const pages = reviewPages(event.day,rows,time);
            pages[0] = `<@&${moderatorRoleId}> ⏰ 預計於 <t:${Math.floor(end/1000)}:t> 結算，請先審核。\n${pages[0]}`;
            const [saved] = await sql`UPDATE daily_events SET review_notice=${JSON.stringify(pages)}::jsonb WHERE day=${event.day} AND kind='quiz' AND result IS NULL AND review_notice IS NULL RETURNING review_notice`;
            if (saved) event.review_notice = saved.review_notice;
            else [event.review_notice] = (await sql`SELECT review_notice FROM daily_events WHERE day=${event.day} AND kind='quiz'`).map(row => row.review_notice);
          }
          for (let page=0; page<event.review_notice.length; page++) {
            const [sent] = await sql`SELECT message_id FROM daily_review_notice_pages WHERE day=${event.day} AND kind='quiz' AND page=${page}`;
            if (!sent) {
              const msg = await send(modChannel,{content:event.review_notice[page],allowedMentions:{roles:page === 0 ? [moderatorRoleId] : [],users:[]}},`review:${page}:quiz:${event.day}`);
              await sql`INSERT INTO daily_review_notice_pages(day,kind,page,message_id) VALUES (${event.day},'quiz',${page},${msg.id}) ON CONFLICT DO NOTHING`;
            }
          }
        }
      }
      for (const event of await sql`SELECT * FROM daily_events WHERE kind = 'quiz' AND (result_message_id IS NULL OR result IS NULL OR (mod_result_message_id IS NULL AND day >= (SELECT value FROM daily_settings WHERE key='mod_notice_start_day')))` ) {
        if (time >= eventTimes(event.day,event.kind).end) await locked(`${event.kind}:${event.day}`, () => close(event, channel, modChannel));
      }
      for (const day of [dateKey(time-DAY),dateKey(time)]) for (const kind of ['quiz']) {
        if (!isActivityDay(day)) continue;
        const { start,end } = eventTimes(day,kind);
        if (time >= start && time < end) await open(day,kind,channel);
      }
      // Settlement and reports must not wait behind an hourly history scan.
      if (giveawayQualification) {
        try { await locked('giveaway:qualification', () => giveawayQualification.tick()); }
        catch (error) { logger.error('DAILY_GIVEAWAY_QUALIFICATION_FAILED', error); }
      }
      if (snapshotsEnabled) {
        try { await refreshScheduledSnapshots({guild,sql,categoryId:groupCategoryId,now:now(),onlyChannelId:privateTestChannelId}); }
        catch(error) { logger.error('DAILY_SNAPSHOT_UPDATE_FAILED',error); }
      }
    } catch (error) { logger.error('DAILY_TICK_FAILED', error); }
    finally { ticking = false; }
  }
  async function handle(interaction) {
    if (interaction.guildId !== guildId) return;
    if (interaction.isChatInputCommand() && interaction.commandName === 'cancel') {
      const settings = {guildId,modChannelId,moderatorRoleId};
      if (!mayManageActivity(interaction,settings)) return interaction.reply({content:'僅限 MOD 在私人管理頻道使用。',flags:EPHEMERAL});
      const targetId = interaction.options.getUser('user',true).id;
      const activity = interaction.options.getString('activity',true);
      if (!['quiz','giveaway'].includes(activity)) return interaction.reply({content:'活動選項無效。',flags:EPHEMERAL});
      if (activity === 'giveaway' && !giveawayQualification) return interaction.reply({content:'Giveaway 資格功能尚未啟用，無法取消該活動資格。',flags:EPHEMERAL});
      if (giveawayQualification && !memberGiveawayEnabled && targetId !== env.DAILY_GIVEAWAY_TEST_USER_ID) return interaction.reply({content:'目前僅能取消指定測試者；正式功能尚未啟用。',flags:EPHEMERAL});
      await interaction.deferReply({flags:EPHEMERAL});
      try {
        const time = now();
        const activeDay = [dateKey(time-DAY),dateKey(time)].find(d => isActivityDay(d) && time >= eventTimes(d,activity).start && time < eventTimes(d,activity).end);
        if (!activeDay) return interaction.editReply('目前沒有進行中的活動，無法取消資格。');
        const result = await locked('giveaway:qualification', () => locked(`quiz:${activeDay}`, async () => {
          const current = now();
          if (current < eventTimes(activeDay,activity).start || current >= eventTimes(activeDay,activity).end) throw Error('DAILY_CANCEL_ACTIVITY_EXPIRED');
          const {guild} = await guildAndChannel();
          const recorded = await recordCancellation({interaction,settings,targetId,activity,sql,now});
          if (activity === 'giveaway') {
            await removeGiveawayRole({guild,roleId:env.DAILY_GIVEAWAY_ROLE_ID,targetId});
          }
          return recorded;
        }));
        if (activity === 'quiz') return interaction.editReply(`已取消 ${result.day} 這場每日答題資格；不影響 Giveaway。`);
        return interaction.editReply(`已取消 ${result.day} 這場 Giveaway 資格並移除資格身分組；不影響每日答題。請在 Giveaway Boat 確認報名狀態；此指令無法自動讀取名單。`);
      } catch (error) {
        logger.error('DAILY_CANCEL_FAILED',error);
        return interaction.editReply('取消未能完整確認。若取消紀錄已寫入會保留，請檢查資格身分組及報名狀態後重試。');
      }
    }
    if (interaction.isChatInputCommand() && interaction.commandName === 'giveaway-track' && giveawayQualification) {
      if (!mayManageActivity(interaction,{guildId,modChannelId,moderatorRoleId})) return interaction.reply({content:'僅限 MOD 在私人管理頻道使用。',flags:EPHEMERAL});
      await interaction.deferReply({flags:EPHEMERAL});
      try {
        const {guild} = await guildAndChannel();
        const day = interaction.options.getString('date',true);
        await registerGiveaway({guild,channelId,boatId:giveawayBoatId,day,messageId:interaction.options.getString('message-id',true),sql});
        return interaction.editReply(`已登記 ${day} 的私人測試抽獎；確認開獎後才會重置資格，完整參賽名單需在 Giveaway Boat 手動查看。`);
      } catch (error) { logger.error('DAILY_GIVEAWAY_REGISTRATION_FAILED',error); return interaction.editReply('登記失敗：請確認日期、訊息 ID 與測試頻道，且該日期沒有登記其他場次。'); }
    }
    if (interaction.isChatInputCommand() && interaction.commandName === 'activity-review') {
      if (!mayManageActivity(interaction,{guildId,modChannelId,moderatorRoleId})) return interaction.reply({content:'僅限 MOD 在私人管理頻道使用。',flags:EPHEMERAL});
      if (interaction.options.getString('activity',true) !== 'quiz') return interaction.reply({content:'尚無法取得 Giveaway Boat 的實際參賽名單，無法提供統計。',flags:EPHEMERAL});
      await interaction.deferReply({flags:EPHEMERAL});
      const time=now();
      const day=[dateKey(time-DAY),dateKey(time)].find(d => isActivityDay(d) && time >= eventTimes(d,'quiz').start && time < eventTimes(d,'quiz').end);
      if (!day) return interaction.editReply('目前沒有進行中的每日答題。');
      const [event] = await sql`SELECT message_id,result FROM daily_events WHERE day=${day} AND kind='quiz'`;
      if (!event?.message_id || event.result) return interaction.editReply('無法確認本場答題正在進行。');
      try {
        const rows=await quizParticipantIncidents(sql,{guildId,day,start:eventTimes(day,'quiz').start,end:time,incidentSql});
        const pages=reviewPages(day,rows,time);
        await interaction.editReply({content:pages[0],allowedMentions:{parse:[]}});
        for (const content of pages.slice(1)) await interaction.followUp({content,flags:EPHEMERAL,allowedMentions:{parse:[]}});
      } catch (error) { logger.error('DAILY_REVIEW_FAILED',error); return interaction.editReply('無法取得參賽者或刷頻紀錄，請檢查資料庫。'); }
      return;
    }
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
    const [,kind,day,action,ownerId,sourceId,answer] = interaction.customId.split(':');
    if (kind !== 'quiz' || interaction.channelId !== channelId) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(midnight(day)) || dateKey(midnight(day)) !== day || !['join','answer'].includes(action)) return interaction.reply({content:'此答題按鈕已過期或無效，請使用當前活動貼文。',flags:EPHEMERAL});
    if (action === 'answer' && (ownerId !== interaction.user.id || !snowflake.test(sourceId || '') || !['A','B','C','D'].includes(answer))) return interaction.reply({content:'這個選項不屬於你的答題畫面。',flags:EPHEMERAL});
    if (action === 'answer') await interaction.deferUpdate();
    else await interaction.deferReply({flags:EPHEMERAL});
    const time = now(), {start,end} = eventTimes(day,kind);
    if (time < start || time >= end) return interaction.editReply({content:'這場活動尚未開始或已截止。',components:[]});
    const [event] = await sql`SELECT message_id,result,question,options FROM daily_events WHERE day=${day} AND kind=${kind}`;
    if (!event || event.result || event.message_id !== (action === 'join' ? interaction.message.id : sourceId)) return interaction.editReply({content:'活動已結束或無法確認，請聯絡 MOD。',components:[]});
    const [existing] = await sql`SELECT 1 FROM daily_entries WHERE day=${day} AND kind=${kind} AND user_id=${interaction.user.id}`;
    if (existing) return interaction.editReply({content:'你已經回答過，答案不能修改。',components:[]});
    try {
      const [disqualified] = await sql`SELECT 1 FROM daily_disqualifications WHERE day=${day} AND kind=${kind} AND user_id=${interaction.user.id}`;
      if (disqualified) return interaction.editReply({content:'本場參賽資格已被取消，請聯絡 MOD。',components:[]});
      if (!await eligible(interaction.guild,interaction.user.id,10,time,start)) return interaction.editReply({content:'目前尚未達到本場答題的發言門檻。',components:[]});
      if (action === 'join') {
        if (now() >= end) return interaction.editReply({content:'活動已截止。',components:[]});
        if (!Array.isArray(event.options) || event.options.length !== 4 || event.options.some(x => typeof x !== 'string')) throw Error('DAILY_QUIZ_OPTIONS_INVALID');
        return interaction.editReply({content:`**${event.question}**\n${event.options.map((x,i)=>`${'ABCD'[i]}. ${x}`).join('\n')}\n\n選擇後立即送出，無法更改。`,components:answerButtons(day,interaction.user.id,event.message_id)});
      }
      return await locked(`${kind}:${day}`, async () => {
        if (now() >= end) return interaction.editReply({content:'活動已截止。',components:[]});
        const [added] = await sql`INSERT INTO daily_entries(day,kind,user_id,answer) SELECT ${day},${kind},${interaction.user.id},${answer} WHERE EXISTS (SELECT 1 FROM daily_events WHERE day=${day} AND kind=${kind} AND result IS NULL) AND NOT EXISTS (SELECT 1 FROM daily_disqualifications WHERE day=${day} AND kind=${kind} AND user_id=${interaction.user.id}) ON CONFLICT DO NOTHING RETURNING user_id`;
        return interaction.editReply({content:added ? `已提交答案 ${answer}，本場不能修改。` : '你已回答、資格已取消或活動已結束。',components:[]});
      });
    } catch (error) { logger.error('DAILY_ELIGIBILITY_FAILED',error); return interaction.editReply({content:'目前無法驗證發言資格，請稍後重試或聯絡 MOD。',components:[]}); }
  }
  return { guildId, commands:[command.toJSON(),reviewCommand.toJSON(),cancelCommand.toJSON(),...(giveawayQualification ? [giveawayTrackCommand.toJSON()] : [])], handle, tick, initialize, async start() { await initialize(); if (giveawayQualification) await giveawayQualification.initialize(); await tick(); timer = setInterval(tick, 30000); }, stop() { clearInterval(timer); } };
}
