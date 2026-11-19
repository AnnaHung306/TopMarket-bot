import assert from 'node:assert/strict';
import { ChannelType, Collection, MessageType } from 'discord.js';
import { hasMessages } from './eligibility.mjs';
import { eventTimes, isActivityDay } from './time.mjs';

const friday = '2026-11-20';
const saturday = '2026-11-21';
assert.equal(isActivityDay(friday), true);
assert.equal(isActivityDay(saturday), false);
assert.equal(isActivityDay('2026-11-22'), false);
assert.equal(isActivityDay('2026-11-23'), true);
assert.equal(new Date(eventTimes(friday, 'quiz').end).toISOString(), '2026-11-21T03:00:00.000Z');
assert.equal(new Date(eventTimes(friday, 'giveaway').end).toISOString(), '2026-11-21T01:00:00.000Z');

const start = eventTimes(friday, 'quiz').start;
const message = (id, at, extra = {}) => ({ id: String(id), createdTimestamp: at, type: MessageType.Default, author: { id:'user', bot:false }, ...extra });
const one = [message(1,start+1), message(2,start-1), message(3,start+2,{author:{id:'bot',bot:true}}), message(4,start+3,{webhookId:'webhook'})];
const two = [message(5,start+1), message(6,start+2,{type:MessageType.Reply})];
const makeChannel = (messages, permitted = true) => ({ parentId:'group', type:ChannelType.GuildText, permissionsFor:()=>({has:()=>permitted}), messages:{fetch:async()=>new Collection(messages.map(m=>[m.id,m]))} });
const channels = new Map([['general',makeChannel(one)], ['chinese',makeChannel(two)]]);
const guild = { members:{me:{}}, channels:{fetch:async id=>channels.get(id)} };
const options = {guild,channelIds:['general','chinese'],categoryId:'group',userId:'user',start,end:start+100,required:3};
assert.equal(await hasMessages(options),true);
assert.equal(await hasMessages({...options,required:4}),false);
channels.set('chinese',makeChannel(two,false));
await assert.rejects(hasMessages({...options,required:1}), /DAILY_GROUP_PERMISSIONS_MISSING/);
console.log('daily eligibility and schedule tests passed');
