import assert from 'node:assert/strict';
import { classifyScamTest, createScamTestHandler, createScamUpdateHandler } from './discord-scam-test.mjs';
import { createLinkChecker, splitLinks } from './discord-link-check.mjs';
import { isRestrictedVerifiedLink } from './discord-verified-link-policy.mjs';
import { PermissionFlagsBits } from 'discord.js';
const base = { guildId: '1541304826674155550', channelId: '1572821315507855430', author: { id: '123', bot: false } };
const verifiedMember = (ids, admin = false) => ({ roles: { cache: new Map(ids.map(id => [id, true])) }, permissions: { has: bit => admin && bit === PermissionFlagsBits.Administrator } });
const verifiedMessage = { ...base, content: 'https://example.com', member: verifiedMember(['1547133122343084043']) };
assert.deepEqual(splitLinks('**https://example.com**').hosts, ['example.com']);
assert.equal(await isRestrictedVerifiedLink({ ...verifiedMessage, content: '**https://example.com**' }, 'trial'), true);
assert.equal(await isRestrictedVerifiedLink(verifiedMessage, 'trial'), true);
assert.equal(await isRestrictedVerifiedLink(verifiedMessage, 'off'), false);
assert.equal(await isRestrictedVerifiedLink({ ...verifiedMessage, channelId: '1548950663008878683' }, 'trial'), false);
assert.equal(await isRestrictedVerifiedLink({ ...verifiedMessage, channelId: '1548950663008878683' }, 'chinese'), true);
assert.equal(await isRestrictedVerifiedLink({ ...verifiedMessage, channelId: '1541307245311164496' }, 'chinese'), false);
assert.equal(await isRestrictedVerifiedLink({ ...verifiedMessage, member: verifiedMember(['1547133122343084043','1571738627460038736']) }, 'trial'), false);
assert.equal(await isRestrictedVerifiedLink({ ...verifiedMessage, member: verifiedMember(['1547133122343084043'], true) }, 'trial'), false);
assert.equal(await isRestrictedVerifiedLink({ ...verifiedMessage, content: '只說文字' }, 'trial'), false);
assert.equal(await isRestrictedVerifiedLink({ ...verifiedMessage, member: verifiedMember([]) }, 'trial'), true);
let restrictedDeleted = false, restrictedAlert;
await createScamTestHandler({ verifiedLinkMode: 'trial' })({ ...verifiedMessage, delete: async () => { restrictedDeleted = true; }, channel: { send: async value => { restrictedAlert = value; } } });
assert.equal(restrictedDeleted, true);
assert.match(restrictedAlert.content, /連結限制提醒/);
assert.doesNotMatch(restrictedAlert.content, /疑似詐騙/);
restrictedDeleted = false;
await createScamUpdateHandler({ verifiedLinkMode: 'trial' })({ content: '舊訊息' }, { ...verifiedMessage, delete: async () => { restrictedDeleted = true; }, channel: { send: async () => {} } });
assert.equal(restrictedDeleted, true);
const positives = [
  '**http://discordapp.com/invite/complaint**',
  '>**http://discordapp.com/invite/complaint**',
  '**https://discord.gg/complaint**',
  '我不小心檢舉你，快加客服好友申訴',
  'I accidentally reported you, add me as a friend to contact support',
  '恭喜獲得 NFT 白名單，連接錢包領取 https://example.invalid',
  'Free Nitro https://example.invalid', 'verify your wallet https://example.invalid',
  '請輸入助記詞', '我要買你的 NFT，先支付中介手續費',
  '加我好友下載遊戲測試版', '你的資產可以追回，先支付驗證費',
  'http://discordapp.com/invite/complaint',
  'https://discordapp.com/invite/complaint?x=1',
  '不要點 http://discordapp.com/invite/complaint，這是詐騙',
  'http://discord.gg/complaint',
  'Submit below >http://discord.gg/complaint>',
  'https://discord.gg/complaint?x=1',
];
const negatives = [
  '早安', '加我好友一起玩', 'add me as a friend', '今天有空投活動嗎？',
  'https://example.invalid', '如何防範詐騙？', 'NFT 交易的手續費怎麼計算？',
  '請勿輸入助記詞，這是詐騙', '不要加客服好友，這種誤檢舉是詐騙',
  'Never share your private key', '今天下載了遊戲，真好玩',
  'https://example.com/airdrop/verify-wallet', 'http://example.com/free-nitro',
  'https://airdrop.example.com/whitelist', 'www.example.com/airdrop',
  '空投活動資訊 https://example.com/airdrop', '討論 NFT 白名單 https://example.com/whitelist',
  'https://discordapp.com/invite/another', 'https://discordapp.com/invite/complaint2',
  'https://notdiscordapp.com/invite/complaint',
  'https://discord.gg/complaint2', 'https://notdiscord.gg/complaint', 'https://discord.gg/another',
];
for (const content of positives) assert.ok(classifyScamTest({ ...base, content }), content);
for (const content of negatives) assert.equal(classifyScamTest({ ...base, content }), null, content);
assert.equal(classifyScamTest({ ...base, channelId: 'another', content: positives[0] }), null);
assert.equal(classifyScamTest({ ...base, author: { bot: true }, content: positives[0] }), null);
assert.equal(classifyScamTest({ ...base, webhookId: '123', content: positives[0] }), null);
for (const channelId of ['1548950663008878683', '1541307245311164496']) {
  assert.match(classifyScamTest({ ...base, channelId, content: 'http://discord.gg/complaint' }, () => true), /攔截指定/);
  let communityDeleted = false, communityAlert;
  await createScamTestHandler({ inScope: () => true, getModChannel: async () => ({ send: async value => { communityAlert = value; } }) })({
    ...base, channelId, content: 'http://discord.gg/complaint', delete: async () => { communityDeleted = true; },
  });
  assert.ok(communityDeleted);
  assert.match(communityAlert.content, /已刪除訊息/);
}
let deleted = false, alert;
await createScamTestHandler()({ ...base, content: positives[0], delete: async () => { deleted = true; }, channel: { send: async value => { alert = value; } } });
assert.ok(deleted); assert.match(alert.content, /疑似詐騙/); assert.match(alert.content, /已刪除/); assert.deepEqual(alert.allowedMentions, { parse: [] });
await createScamTestHandler()({ ...base, content: positives[0], delete: async () => { throw Error('no permission'); }, channel: { send: async value => { alert = value; } } });
assert.match(alert.content, /刪除失敗/);
deleted = false; alert = null;
await createScamTestHandler({ checkLinks: async () => { throw Error('must not look up blocked link'); }, getModChannel: async () => { assert.ok(deleted, 'delete before resolving MOD channel'); return { send: async value => { alert = value; } }; } })({ ...base, content: 'http://discordapp.com/invite/complaint', delete: async () => { deleted = true; } });
assert.ok(deleted); assert.match(alert.content, /攔截指定的不安全邀請連結/); assert.match(alert.content, /已刪除/);
deleted = false; alert = null;
await createScamTestHandler({ checkLinks: async () => { throw Error('blocked invite should skip DNS'); } })({ ...base, content: 'Submit below >http://discord.gg/complaint>', delete: async () => { deleted = true; }, channel: { send: async value => { alert = value; } } });
assert.ok(deleted); assert.match(alert.content, /攔截指定的不安全邀請連結/); assert.match(alert.content, /已刪除測試訊息/);
for (const extra of [{ author: { id: '321', bot: true } }, { webhookId: '123' }]) {
  deleted = false;
  await createScamTestHandler()({ ...base, ...extra, content: 'http://discordapp.com/invite/complaint', delete: async () => { deleted = true; }, channel: { send: async () => {} } });
  assert.ok(deleted, 'target link from bot or webhook should be deleted');
}
deleted = false;
await createScamTestHandler()({ ...base, author: { id: '999', bot: true }, client: { user: { id: '999' } }, content: 'http://discordapp.com/invite/complaint', delete: async () => { deleted = true; } });
assert.equal(deleted, false, 'own bot messages are excluded');
const handleEdit = createScamUpdateHandler();
await handleEdit({ content: 'original' }, { ...base, content: 'edited http://discordapp.com/invite/complaint', delete: async () => { deleted = true; }, channel: { send: async () => {} } });
assert.ok(deleted, 'link added by editing should be deleted');
deleted = false;
await handleEdit({ content: 'original' }, { ...base, content: '請輸入助記詞', delete: async () => { deleted = true; } });
assert.equal(deleted, false, 'other rules are not applied to edits');
assert.deepEqual(splitLinks('看看 https://example.com/airdrop?secret=private').hosts, ['example.com']);
let queries = [];
const checker = createLinkChecker({ fetchImpl: async url => {
  queries.push(url.toString());
  const name = url.searchParams.get('name');
  const blocked = name === 'malware.testcategory.com' || (name === 'nudity.testcategory.com' && url.hostname === 'family.cloudflare-dns.com');
  return { ok: true, json: async () => ({ Status: 0, Answer: [{ type: 1, data: blocked ? '0.0.0.0' : '192.0.2.1' }] }) };
} });
assert.match((await checker(['malware.testcategory.com'])).reason, /惡意/);
assert.match((await checker(['nudity.testcategory.com'])).reason, /成人/);
assert.equal((await checker(['example.com'])).reason, null);
assert.ok(queries.every(q => !q.includes('secret') && !q.includes('private')));
assert.equal((await createLinkChecker({ fetchImpl: async () => { throw Error('offline'); } })(['example.com'])).unavailable, true);
assert.equal((await checker(['example.invalid'])).reason, null);
assert.equal((await checker(['a.com','b.com','c.com','d.com','e.com','f.com'])).unavailable, true);
let lookupCalls = 0;
await createScamTestHandler({ checkLinks: async () => { lookupCalls++; return { reason: '分類測試', unavailable: false }; } })({ ...base, channelId: 'another', content: 'https://example.com' });
assert.equal(lookupCalls, 0);
let alerts = [];
await createScamTestHandler({ checkLinks: async () => ({ reason: null, unavailable: true }) })({ ...base, content: 'https://example.com', delete: async () => { throw Error('must not delete'); }, channel: { send: async value => alerts.push(value) } });
assert.match(alerts[0].content, /無法完成風險查詢/);
await createScamTestHandler({ checkLinks: async () => ({ reason: 'Cloudflare 分類為成人內容網域', unavailable: false }) })({ ...base, content: 'https://example.com', delete: async () => {}, channel: { send: async value => { alert = value; } } });
assert.match(alert.content, /疑似成人內容測試提醒/);
assert.doesNotMatch(alert.content, /疑似詐騙/);
console.log('Scam test scope, examples, deletion and alert tests passed');
