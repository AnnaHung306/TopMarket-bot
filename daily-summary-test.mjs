import assert from 'node:assert/strict';
import { previousTaipeiDay, readDay, requestSummary, runDailySummary, resolveSpeakerNames, speakerMarkdownChunks, startDailySummary, renderSummary, formatPeriod, splitSummary, verifySummaryClaims } from './discord-daily-summary.mjs';
import { createSummaryLifecycle } from './discord-summary-lifecycle.mjs';

const period = previousTaipeiDay(Date.parse('2026-11-20T23:15:00+08:00'));
assert.deepEqual(period, { start: Date.parse('2026-11-19T23:00:00+08:00'), end: Date.parse('2026-11-20T23:00:00+08:00'), date: '2026-11-20' });
assert.equal(formatPeriod(period), '2026-11-19 23:00 至 2026-11-20 23:00（台灣時間，結束時間不含）');
assert.equal(previousTaipeiDay(Date.parse('2026-11-20T22:59:59+08:00')).date, '2026-11-19');
const msg = (id, time, content, bot = false) => ({ id, createdTimestamp: Date.parse(time), content, author: { bot, id: bot ? 'bot' : '42', username: 'tester' } });
const source = { id: '1548950663008878683', messages: { fetch: async () => new Map([
  ['1', msg('1', '2026-11-20T02:00:00+08:00', '話題 <@123> test@example.com')],
  ['2', msg('2', '2026-11-20T03:00:00+08:00', '機器人', true)],
  ['3', msg('3', '2026-11-20T23:00:00+08:00', '不在範圍')],
  ['4', msg('4', '2026-11-20T04:00:00+08:00', '')],
  ['5', { ...msg('5', '2026-11-20T05:00:00+08:00', '系統訊息'), system: true }],
]) } };
const { messages, speakers, totalHuman } = await readDay(source, period.start, period.end);
assert.deepEqual(messages, [{ id: '1', authorId: '42', content: '話題 [使用者] [電子郵件]' }]);
assert.equal(totalHuman, 2); assert.equal(speakers[0].id, '42'); assert.equal(speakers[0].count, 2);
const memberFetcher = { fetch: async () => ({ displayName: 'tester' }) };
const named = await resolveSpeakerNames({ members: memberFetcher }, messages, speakers);
assert.equal(messages[0].authorName, 'tester');
assert.match(speakerMarkdownChunks(named)[0], /\*\*tester\*\*：2 則/);
const duplicateMessages = [{authorId:'1'},{authorId:'2'},{authorId:'3'}];
const duplicateSpeakers = [{id:'1',count:1},{id:'2',count:2},{id:'3',count:1}];
const duplicateNames = await resolveSpeakerNames({ members: { fetch: async id => { if (id === '3') throw Object.assign(Error('not found'), { code:10007 }); return { displayName:'@same' }; } } }, duplicateMessages, duplicateSpeakers);
assert.deepEqual(duplicateNames.map(x=>x.displayName), ['＠same（同名 1）','＠same（同名 2）','暱稱無法取得']);
assert.doesNotMatch(speakerMarkdownChunks(duplicateNames).join(''), /@/);
await assert.rejects(() => readDay(source, period.start, period.end, { maxCharacters: 1 }), /SUMMARY_INPUT_LIMIT/);
const firstPage = new Map(Array.from({ length: 100 }, (_, i) => [String(200 - i), msg(String(200 - i), '2026-11-20T02:00:00+08:00', `訊息${i}`)]));
const secondPage = new Map([['99', msg('99', '2026-11-20T01:00:00+08:00', '較早')], ['98', msg('98', '2026-11-19T22:59:00+08:00', '範圍外')]]);
const calls = [];
const paged = { messages: { fetch: async options => { calls.push(options); return calls.length === 1 ? firstPage : secondPage; } } };
assert.equal((await readDay(paged, period.start, period.end)).totalHuman, 101);
assert.equal(calls.length, 2);
assert.equal(calls[0].before, ((BigInt(period.end) - 1420070400000n) << 22n).toString());
assert.equal(calls[1].before, '101');
await assert.rejects(() => requestSummary(messages, { apiKey: '' }), /SUMMARY_API_KEY_MISSING/);
let posted = [];
const api = async (url, options) => {
  assert.equal(url, 'https://api.openai.com/v1/responses');
  const body = JSON.parse(options.body);
  assert.equal(body.store, false);
  assert.equal(body.model, 'gpt-6-luna');
  assert.match(body.input, /\[電子郵件\]/);
  assert.doesNotMatch(body.input, /authorId/);
  assert.equal(body.text.format.type, 'json_schema');
  if (body.text.format.name === 'discord_summary_review') {
    const claims = JSON.parse(body.input);
    return { ok: true, json: async () => ({ status:'completed', output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({checks:claims.map(c=>({key:c.key,verdict:'accurate',text:c.claim}))})}]}] }) };
  }
  return { ok: true, json: async () => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ events: [{ topic: '活動', text: '提出話題', message_ids: ['m1'] }], sentiment: [], pending: [] }) }] }] }) };
};
assert.match(await requestSummary(messages, { apiKey: 'fake', fetchImpl: api }), /tester.*提出話題/);
assert.throws(() => renderSummary({ events: [{ topic: '活動', text: '未經證實', message_ids: ['m999'] }], sentiment: [], pending: [] }, messages), /SUMMARY_SOURCE_INVALID/);
assert.throws(() => renderSummary({ events: [{ topic: '活動', text: '<@42> 有人說', message_ids: ['m1'] }], sentiment: [], pending: [] }, messages), /SUMMARY_OUTPUT_UNSAFE/);
const noYield = [{ id:'3', authorName:'測試者', content:'没人抽50U的卡了吗？我都好几天没收益了' }];
assert.throws(() => renderSummary({ events:[{topic:'收益',text:'表示已好幾天沒抽 50U 卡並取得收益。',message_ids:['m1']}],sentiment:[],pending:[] }, noYield), /SUMMARY_SOURCE_MISMATCH/);
assert.match(renderSummary({ events:[{topic:'收益',text:'表示好幾天沒有收益。',message_ids:['m1']}],sentiment:[],pending:[] }, noYield), /沒有收益/);
const badClaim={events:[{topic:'收益',text:'表示已好幾天沒抽 50U 卡並取得收益。',message_ids:['m1']}],sentiment:[],pending:[]};
const correctionApi=async (url, options)=>{const claim=JSON.parse(options.body).input;assert.match(claim,/没收益/);return {ok:true,json:async()=>({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({checks:[{key:'events:0',verdict:'corrected',text:'詢問是否沒人抽卡，並表示好幾天沒有收益。'}]})}]}]})};};
const corrected=await verifySummaryClaims(badClaim,noYield,{apiKey:'fake',fetchImpl:correctionApi});
assert.match(renderSummary(corrected,noYield), /好幾天沒有收益/);
const unverified=await verifySummaryClaims(badClaim,noYield,{apiKey:'fake',fetchImpl:async()=>({ok:true,json:async()=>({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({checks:[{key:'events:0',verdict:'cannot_verify',text:''}]})}]}]})})});
const unverifiedText=renderSummary(unverified,noYield);
assert.match(unverifiedText,/待人工核對（原文摘錄/);assert.match(unverifiedText,/好几天没收益/);assert.doesNotMatch(unverifiedText,/並取得收益/);
await assert.rejects(() => verifySummaryClaims(badClaim,noYield,{apiKey:'fake',fetchImpl:async()=>({ok:true,json:async()=>({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({checks:[]})}]}]})})}), /SUMMARY_REVIEW_INVALID/);
await assert.rejects(() => verifySummaryClaims(badClaim,noYield,{apiKey:'fake',fetchImpl:async()=>({ok:true,json:async()=>({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({checks:[{key:'events:0',verdict:'accurate',text:'擅自變更的文字'}]})}]}]})})}), /SUMMARY_REVIEW_INVALID/);
let attempts = 0;
const retryApi = async (url, options) => {
  if (JSON.parse(options.body).text.format.name === 'discord_summary_review') return api(url, options);
  attempts++;
  if (attempts === 1) return { ok: true, json: async () => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ events: [{topic:'活動',text:'有人詢問',message_ids:['m1']}],sentiment:[],pending:[] }) }] }] }) };
  return api(url, options);
};
assert.match(await requestSummary(messages, { apiKey:'fake', fetchImpl:retryApi }), /tester.*提出話題/);
assert.equal(attempts, 2);
const multi = renderSummary({ events: [{ topic: '維護', text: '安排維護', message_ids:['m1'] }, { topic: '維護', text: '延長維護', message_ids:['m2'] }], sentiment: [], pending: [] }, [{id:'1',authorName:'en'},{id:'2',authorName:'johnnyroger'}]);
assert.equal((multi.match(/\*\*維護\*\*/g)||[]).length, 1); assert.match(multi,/en.*安排維護/); assert.match(multi,/johnnyroger.*延長維護/);
assert.ok(splitSummary(Array(5).fill('x'.repeat(1000)).join('\n')).length > 1);
await assert.rejects(() => requestSummary(messages, { apiKey: 'fake', fetchImpl: async () => ({ ok: false, status: 429 }) }), /SUMMARY_API_HTTP_429/);
await assert.rejects(() => requestSummary(messages, { apiKey: 'fake', fetchImpl: async () => ({ ok: true, json: async () => ({ status: 'incomplete' }) }) }), /SUMMARY_API_INCOMPLETE/);
const target = { id: '1572821315507855430', send: async value => { posted.push(value); } };
const guild = { members: memberFetcher, channels: { fetch: async id => id === source.id ? source : target } };
const client = { guilds: { fetch: async () => guild } };
let claimed = false; let status;
const db = { query: async ({ text, values }) => {
  assert.equal(values[0], '2026-11-20');
  if (text.includes('INSERT')) { if (claimed) return { rowCount: 0 }; claimed = true; return { rowCount: 1 }; }
  status = text.includes("'sent'") ? 'sent' : values[1]; return { rowCount: 1 };
} };
const params = { client, db, apiKey: 'fake', canAct: async () => true, now: Date.parse('2026-11-20T23:15:00+08:00'), fetchImpl: api };
assert.equal(await runDailySummary(params), 'sent');
assert.equal(status, 'sent'); assert.match(posted[0].content, /2026-11-19 23:00 至 2026-11-20 23:00/); assert.deepEqual(posted[0].allowedMentions.parse, []);
assert.match(posted[0].embeds[0].description, /tester/);
assert.match(posted[1].content, /\*\*tester\*\*：2 則/);
assert.doesNotMatch(posted.map(x=>x.content).join(''), /ID 42|@/);
assert.equal(await runDailySummary(params), 'already-claimed');
const manualReviewPosts=[];
const manualReviewTarget={...target,send:async value=>manualReviewPosts.push(value)};
const manualReviewClient={guilds:{fetch:async()=>({members:memberFetcher,channels:{fetch:async id=>id===source.id?source:manualReviewTarget}})}};
const manualReviewDb={query:async q=>q.text.includes('INSERT')?{rowCount:1}:{rowCount:1}};
const manualReviewApi=async (url,options)=>{const body=JSON.parse(options.body);if(body.text.format.name!=='discord_summary_review')return api(url,options);const checks=JSON.parse(body.input).map(c=>({key:c.key,verdict:'cannot_verify',text:''}));return {ok:true,json:async()=>({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({checks})}]}]})};};
assert.equal(await runDailySummary({...params,client:manualReviewClient,db:manualReviewDb,fetchImpl:manualReviewApi}), 'sent');
assert.match(manualReviewPosts[0].embeds[0].description,/待人工核對（原文摘錄/);
assert.match(manualReviewPosts[0].embeds[0].description,/話題/);
assert.doesNotMatch(manualReviewPosts[0].embeds[0].description,/@/);
claimed = false; posted = [];
await assert.rejects(() => runDailySummary({ ...params, fetchImpl: async () => ({ ok: false, status: 429 }) }), /SUMMARY_API_HTTP_429/);
assert.equal(status, 'failed'); assert.match(posted[0].content, /未完成/);
claimed = false; posted = [];
await assert.rejects(() => runDailySummary({ ...params, canAct: async () => false }), /SUMMARY_LOCK_LOST/);
assert.equal(posted.length, 0); assert.equal(claimed, false);
await assert.rejects(() => runDailySummary({ ...params, apiKey: '' }), /SUMMARY_API_KEY_MISSING/);
assert.equal(claimed, false);
const notices = [];
const failAfterSendDb = { query: async ({ text, values }) => {
  if (text.includes('INSERT')) return { rowCount: 1 };
  if (text.includes("'sent'")) throw Error('DB unavailable after send');
  assert.equal(values[1], 'uncertain'); return { rowCount: 1 };
} };
const failTarget = { ...target, send: async value => { notices.push(value.content); } };
const failClient = { guilds: { fetch: async () => ({ members: memberFetcher, channels: { fetch: async id => id === source.id ? source : failTarget } }) } };
await assert.rejects(() => runDailySummary({ ...params, db: failAfterSendDb, client: failClient }), /DB unavailable/);
assert.equal(notices.length, 3); assert.match(notices[2], /摘要已傳送/);
const timedOutNotices = []; let timedOutStatus;
const timedOutTarget = { ...target, send: async value => {
  timedOutNotices.push(value.content);
  if (timedOutNotices.length === 1) throw Error('Discord request timed out');
} };
const timedOutClient = { guilds: { fetch: async () => ({ members: memberFetcher, channels: { fetch: async id => id === source.id ? source : timedOutTarget } }) } };
const timedOutDb = { query: async ({ text, values }) => {
  if (text.includes('INSERT')) return { rowCount: 1 };
  timedOutStatus = values[1]; return { rowCount: 1 };
} };
await assert.rejects(() => runDailySummary({ ...params, db: timedOutDb, client: timedOutClient }), /timed out/);
assert.equal(timedOutStatus, 'uncertain');
assert.match(timedOutNotices[1], /發送狀態不確定/);
let finishStart; let stopped = 0;
const gate = new Promise(resolve => { finishStart = resolve; });
const lifecycle = createSummaryLifecycle({ start: async () => { await gate; return async () => { stopped++; }; } });
lifecycle.start();
const closing = lifecycle.close();
assert.equal(stopped, 0);
finishStart();
await closing;
await lifecycle.close();
lifecycle.start();
assert.equal(stopped, 1);
let errorSeen = false;
const failingLifecycle = createSummaryLifecycle({ start: async () => { throw Error('init failure'); }, onError: () => { errorSeen = true; } });
failingLifecycle.start(); await failingLifecycle.close(); assert.equal(errorSeen, true);
let deliveryDone;
const deliveredPromise = new Promise(resolve => { deliveryDone = resolve; });
const latest = previousTaipeiDay();
const nowSource = { id: source.id, messages: { fetch: async () => new Map([['91', msg('91', new Date(latest.start + 60000).toISOString(), '測試')]]) } };
const nowTarget = { id: target.id, send: async value => { if (/tester/.test(value.content)) deliveryDone(); } };
const nowClient = { guilds: { fetch: async () => ({ members: memberFetcher, channels: { fetch: async id => id === nowSource.id ? nowSource : nowTarget } }) } };
let dbClosed = false;
const nowDb = { on() {}, async connect() {}, async end() { dbClosed = true; }, async query(q) { if (typeof q === 'string') return {}; return { rowCount: 1 }; } };
const stop = await startDailySummary({ client: nowClient, apiKey: 'fake', canAct: async () => true, makeClient: () => nowDb, runOnStart: true,
  fetchImpl: async (url, options) => { const b=JSON.parse(options.body); const out=b.text.format.name==='discord_summary_review' ? {checks:JSON.parse(b.input).map(c=>({key:c.key,verdict:'accurate',text:c.claim}))} : {events:[{topic:'測試',text:'測試摘要',message_ids:['m1']}],sentiment:[],pending:[]}; return {ok:true,json:async()=>({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(out)}]}]})}; } });
await Promise.race([deliveredPromise, new Promise((_, reject) => setTimeout(() => reject(Error('Immediate summary timed out')), 2000))]);
await stop(); assert.equal(dbClosed, true);
console.log('Daily summary scope, pagination inputs, OpenAI contract, failure and deduplication tests passed');
