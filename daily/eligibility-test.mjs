import assert from 'node:assert/strict';
import { ChannelType, Collection, MessageType } from 'discord.js';
import { hasMessages } from './eligibility.mjs';
import { eventTimes, isActivityDay, reportTime } from './time.mjs';
import { activityRules } from './activity-rules.mjs';

const friday = '2026-11-20';
const saturday = '2026-11-21';
assert.equal(isActivityDay(friday), true);
assert.equal(isActivityDay(saturday), false);
assert.equal(isActivityDay('2026-11-22'), false);
assert.equal(isActivityDay('2026-11-23'), true);
assert.equal(new Date(eventTimes(friday, 'quiz').start).toISOString(), '2026-11-20T02:00:00.000Z');
assert.equal(new Date(eventTimes(friday, 'quiz').end).toISOString(), '2026-11-21T01:00:00.000Z');
assert.equal(new Date(reportTime(friday, 'quiz')).toISOString(), '2026-11-21T02:00:00.000Z');
assert.equal(reportTime(friday,'giveaway'), reportTime(friday,'quiz'));
for (const kind of ['quiz','giveaway']) {
  assert.match(activityRules(friday,kind), /週六 09:00 (結算|開獎)/);
  assert.match(activityRules(friday,kind), /09:00 至 10:00 為非活動期間/);
  assert.match(activityRules(friday,kind), /2026 年 11 月 20 日 10:00 開始，2026 年 11 月 21 日 09:00/);
}
assert.deepEqual(eventTimes(friday, 'quiz'), eventTimes(friday, 'giveaway'));
for (const day of ['2026-11-21','2026-11-22','2026-11-23','2026-11-24','2026-11-25','2026-11-26','2026-11-27']) {
  for (const kind of ['quiz','giveaway']) {
    const {start,end}=eventTimes(day,kind);
    assert.equal(end-start,23*3600000);
    assert.equal(reportTime(day,kind)-end,3600000);
    assert.equal((new Date(start+8*3600000)).getUTCHours(),10);
    assert.equal((new Date(end+8*3600000)).getUTCHours(),9);
    assert.equal((new Date(reportTime(day,kind)+8*3600000)).getUTCHours(),10);
  }
}
assert.throws(() => eventTimes(friday, 'other'), /DAILY_ACTIVITY_KIND_INVALID/);

const start = eventTimes(friday, 'quiz').start;
const message = (id, at, extra = {}) => ({ id: String(id), createdTimestamp: at, type: MessageType.Default, author: { id:'user', bot:false }, ...extra });
const one = [message(1,start+1), message(2,start-1), message(3,start+2,{author:{id:'bot',bot:true}}), message(4,start+3,{webhookId:'webhook'})];
const two = [message(5,start+1), message(6,start+2,{type:MessageType.Reply})];
const makeChannel = (messages, permitted = true) => ({ parentId:'group', type:ChannelType.GuildText, permissionsFor:()=>({has:()=>permitted}), messages:{fetch:async()=>new Collection(messages.map(m=>[m.id,m]))} });
const channels = new Map([['general',makeChannel(one)], ['chinese',makeChannel(two)]]);
channels.set('thread', {parentId:'group', type:ChannelType.PublicThread});
channels.set('other', {...makeChannel([message(7,start+2)]),parentId:'other'});
const guild = { members:{me:{}}, channels:{fetch:async id=>id ? channels.get(id) : new Collection(channels)} };
const options = {guild,channelIds:['general','chinese'],categoryId:'group',userId:'user',start,end:start+100,required:3};
assert.equal(await hasMessages(options),true);
assert.equal(await hasMessages({...options,required:4}),false);
channels.set('mod-test',makeChannel([message(8,start+2)]));
assert.equal(await hasMessages({...options,required:4}),true);
channels.set('chinese',makeChannel(two,false));
await assert.rejects(hasMessages({...options,required:1}), /DAILY_GROUP_PERMISSIONS_MISSING/);
console.log('daily eligibility and schedule tests passed');
