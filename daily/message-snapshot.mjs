import { ChannelType, MessageType, PermissionFlagsBits } from 'discord.js';
import { dateKey, eventTimes, isActivityDay, midnight } from './time.mjs';

const DAY=86400000;

// The 09:00 slot belongs to yesterday's ended activity; 10:00 onward
// belongs to today, and only weekdays have a new activity.
export function scheduledSnapshot(now) {
  const today=dateKey(now), hour=new Date(now+8*3600000).getUTCHours();
  if(hour<9 || hour>21) return null;
  // The 21:00 job may start during the scheduler's first minute, but a late
  // restart must not begin a new refresh throughout the rest of the evening.
  if(hour===21 && now>=midnight(today)+21*3600000+60000) return null;
  const day=hour===9?dateKey(midnight(today)-DAY):today;
  if(!isActivityDay(day)) return null;
  const {start,end}=eventTimes(day,'quiz');
  return {day,start,end:Math.min(now,end),slot:`${today}-${String(hour).padStart(2,'0')}`};
}

// Discord history is newest-first. Walk backwards to the previous cursor;
// never advance the cursor after an incomplete scan or a permission error.
export async function scanSnapshotChannel(channel, {member,start,end,afterId=null,maxPages=100}) {
  if(!channel.permissionsFor(member)?.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.ReadMessageHistory])) throw Error('DAILY_SNAPSHOT_PERMISSIONS_MISSING');
  const entries=[];
  let before, newest=afterId, complete=false, recent=null;
  for(let i=0;i<maxPages;i++) {
    const page=await channel.messages.fetch({limit:100,...(before?{before}:{})});
    if(i===0) recent=page;
    if(!page.size){complete=true;break;}
    for(const m of page.values()) {
      if(!/^\d{17,20}$/.test(m.id)) throw Error('DAILY_SNAPSHOT_MESSAGE_ID_INVALID');
      if(afterId && BigInt(m.id)<=BigInt(afterId)){complete=true;break;}
      if(m.createdTimestamp<start){complete=true;break;}
      if(m.createdTimestamp>=end) continue;
      if(!newest || BigInt(m.id)>BigInt(newest)) newest=m.id;
      if([MessageType.Default,MessageType.Reply].includes(m.type) && m.author?.id && !m.author.bot && !m.webhookId) entries.push({message_id:m.id,user_id:m.author.id});
    }
    if(complete || page.size<100){complete=true;break;}
    before=page.last().id;
  }
  if(!complete) throw Error('DAILY_SNAPSHOT_SCAN_INCOMPLETE');
  return {entries,cursor:newest,recent};
}

export async function initializeSnapshots(sql) {
  await sql`CREATE TABLE IF NOT EXISTS daily_chat_snapshot_messages(day text NOT NULL,channel_id text NOT NULL,message_id text NOT NULL,user_id text NOT NULL,PRIMARY KEY(day,channel_id,message_id))`;
  await sql`CREATE TABLE IF NOT EXISTS daily_chat_snapshot_counts(day text NOT NULL,channel_id text NOT NULL,user_id text NOT NULL,count integer NOT NULL,PRIMARY KEY(day,channel_id,user_id))`;
  await sql`CREATE TABLE IF NOT EXISTS daily_chat_snapshot_cursors(day text NOT NULL,channel_id text NOT NULL,message_id text,PRIMARY KEY(day,channel_id))`;
  await sql`ALTER TABLE daily_chat_snapshot_cursors ADD COLUMN IF NOT EXISTS snapshot_slot text`;
}

// Keep today and the preceding two Taiwan calendar dates. One transaction
// ensures an interruption cannot leave the three snapshot tables inconsistent.
export async function pruneSnapshots(sql, now) {
  if (!Number.isFinite(now)) throw Error('DAILY_SNAPSHOT_RETENTION_TIME_INVALID');
  if (typeof sql.transaction !== 'function') throw Error('DAILY_SNAPSHOT_TRANSACTIONS_REQUIRED');
  const cutoff = dateKey(midnight(dateKey(now)) - 2 * DAY);
  await sql.transaction([
    sql`DELETE FROM daily_chat_snapshot_counts WHERE day < ${cutoff}`,
    sql`DELETE FROM daily_chat_snapshot_messages WHERE day < ${cutoff}`,
    sql`DELETE FROM daily_chat_snapshot_cursors WHERE day < ${cutoff}`,
  ]);
  return cutoff;
}

// Rebuild each hourly snapshot from the live channel so deletions while the bot
// was offline are reflected in stored totals. All writes commit together.
export async function replaceSnapshot(sql,{day,channelId,entries,cursor,slot}) {
  if(typeof sql.transaction!=='function') throw Error('DAILY_SNAPSHOT_TRANSACTIONS_REQUIRED');
  await sql.transaction([
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${day}:${channelId}`},0))`,
    sql`DELETE FROM daily_chat_snapshot_counts WHERE day=${day} AND channel_id=${channelId}`,
    sql`DELETE FROM daily_chat_snapshot_messages WHERE day=${day} AND channel_id=${channelId}`,
    sql`INSERT INTO daily_chat_snapshot_messages(day,channel_id,message_id,user_id)
      SELECT ${day},${channelId},message_id,user_id FROM jsonb_to_recordset(${JSON.stringify(entries)}::jsonb) AS x(message_id text,user_id text) ON CONFLICT DO NOTHING`,
    sql`INSERT INTO daily_chat_snapshot_counts(day,channel_id,user_id,count)
      SELECT ${day},${channelId},user_id,count(*)::int FROM daily_chat_snapshot_messages WHERE day=${day} AND channel_id=${channelId} GROUP BY user_id`,
    sql`INSERT INTO daily_chat_snapshot_cursors(day,channel_id,message_id,snapshot_slot) VALUES (${day},${channelId},${cursor},${slot})
      ON CONFLICT(day,channel_id) DO UPDATE SET message_id=excluded.message_id,snapshot_slot=excluded.snapshot_slot`,
  ]);
}

export async function refreshScheduledSnapshots({guild,sql,categoryId,now,onlyChannelId=null}) {
  const target=scheduledSnapshot(now);
  if(!target) return {updated:0};
  const all=await guild.channels.fetch();
  const channels=[...all.values()].filter(c=>c?.parentId===categoryId && c.type===ChannelType.GuildText && (!onlyChannelId||c.id===onlyChannelId));
  if(!channels.length) throw Error('DAILY_GROUP_CHANNELS_MISSING');
  for(const channel of channels) if(!channel.permissionsFor(guild.members.me)?.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.ReadMessageHistory])) throw Error('DAILY_SNAPSHOT_PERMISSIONS_MISSING');
  let updated=0;
  for(const channel of channels) {
    const [saved]=await sql`SELECT snapshot_slot FROM daily_chat_snapshot_cursors WHERE day=${target.day} AND channel_id=${channel.id}`;
    if(saved?.snapshot_slot===target.slot) continue;
    const scan=await scanSnapshotChannel(channel,{member:guild.members.me,start:target.start,end:target.end});
    await replaceSnapshot(sql,{day:target.day,channelId:channel.id,entries:scan.entries,cursor:scan.cursor,slot:target.slot});
    updated++;
  }
  return {updated,day:target.day,slot:target.slot};
}

// Snapshot totals are not blindly trusted: messages deleted after the hourly
// snapshot are rechecked by ID. Newer messages are scanned without writing to
// the database, and all channel permissions are checked before any success.
export async function eligibleWithSnapshot({guild,sql,day,categoryId,userId,start,end,required,onlyChannelId=null}) {
  const all=await guild.channels.fetch();
  const channels=[...all.values()].filter(c=>c?.parentId===categoryId && c.type===ChannelType.GuildText && (!onlyChannelId||c.id===onlyChannelId));
  if(!channels.length) throw Error('DAILY_GROUP_CHANNELS_MISSING');
  for(const channel of channels) if(!channel.permissionsFor(guild.members.me)?.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.ReadMessageHistory])) throw Error('DAILY_SNAPSHOT_PERMISSIONS_MISSING');
  let count=0;
  for(const channel of channels) {
    const [state]=await sql`SELECT message_id FROM daily_chat_snapshot_cursors WHERE day=${day} AND channel_id=${channel.id}`;
    const cursor=state?.message_id || null;
    const fresh=await scanSnapshotChannel(channel,{member:guild.members.me,start,end:end+1,afterId:cursor});
    count+=fresh.entries.filter(x=>x.user_id===userId).length;
    if(count>=required) return true;
    if(!cursor) continue; // First scan of a new channel starts at the activity boundary.
    const rows=await sql`SELECT message_id FROM daily_chat_snapshot_messages WHERE day=${day} AND channel_id=${channel.id} AND user_id=${userId} ORDER BY message_id DESC`;
    const freshIds=new Set(fresh.entries.map(x=>x.message_id));
    const pending=new Set(rows.map(x=>x.message_id).filter(id=>!freshIds.has(id)));
    const valid=m=>m?.author?.id===userId && !m.author.bot && !m.webhookId && [MessageType.Default,MessageType.Reply].includes(m.type) && m.createdTimestamp>=start && m.createdTimestamp<=end;
    const consumePage=page=>{
      let min=null,max=null;
      for(const m of page.values()) {
        if(!/^\d{17,20}$/.test(m.id)) throw Error('DAILY_SNAPSHOT_MESSAGE_ID_INVALID');
        const id=BigInt(m.id);if(min===null||id<min) min=id;if(max===null||id>max) max=id;
        if(pending.delete(m.id) && valid(m)) count++;
      }
      for(const id of pending) if(min!==null && BigInt(id)>=min && BigInt(id)<=max) pending.delete(id);
    };
    // The tail scan already fetched the newest page; reuse it to validate
    // cached entries instead of making an extra Discord request.
    if(fresh.recent) consumePage(fresh.recent);
    while(pending.size && count<required) {
      const anchor=pending.values().next().value;
      const page=await channel.messages.fetch({around:anchor,limit:100,cache:false});
      consumePage(page);
      // IDs strictly inside the returned range but absent from the page were
      // deleted. For an anchor outside that range, verify the exact message.
      if(pending.has(anchor)) {
        let m;
        try {m=await channel.messages.fetch({message:anchor,force:true});}
        catch(error) {if(error.code!==10008) throw error;}
        pending.delete(anchor);
        if(m?.id===anchor && valid(m)) count++;
      }
    }
    if(count>=required) return true;
  }
  return false;
}
