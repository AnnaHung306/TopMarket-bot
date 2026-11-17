import assert from 'node:assert/strict';
import { createWalletHandler } from './discord-interaction.mjs';

function interaction(address) {
  const edits = [], messages = [];
  const thread = { id:'thread-123', async send(payload) { messages.push(payload); return { async edit(value) { edits.push(value); } }; } };
  return { commandName:'wallet', isChatInputCommand:()=>true, options:{ getString:()=>address },
    user:{ id:'123456789012345678', username:'test-user' }, member:{ displayName:'測試用戶' }, edits, messages,
    async deferReply() { this.deferred = true; this.ackAt = performance.now(); },
    channel: { threads: { async create() { return thread; } } },
    async editReply(payload) { if (!this.first) this.first = payload; else edits.push(payload); this.replied = true; } };
}

const wallet='0x'+'a'.repeat(40), snapshot={ through: 99 };

// A failed scan is recorded across handler restarts; checking the cached
// snapshot must still work and consume no scan quota.
let blocked = false, reads = 0, reserved = 0, hasSnapshot = false;
const options = {
  configured: () => true,
  readSnapshot: async () => hasSnapshot ? snapshot : null,
  scanBlocked: async () => blocked,
  recordScanFailure: async () => { blocked = true; },
  reserveScan: async () => { reserved++; return true; },
  readPage: async () => { reads++; throw Error('simulated upstream failure'); },
  renderPoster: () => Buffer.from('PNG'), formatReport: () => '摘要',
};
const originalError = console.error; console.error = () => {};
try {
  await createWalletHandler(options)(interaction(wallet));
  const retry = interaction(wallet);
  await createWalletHandler(options)(retry);
  assert.equal(reads, 2);
  assert.equal(reserved, 1);
  assert.match(retry.edits.at(-1), /暫停重試/);
  hasSnapshot = true;
  const cached = interaction(wallet);
  await createWalletHandler(options)(cached);
  assert.equal(cached.messages.at(-1).files[0].name, 'wallet-report.png');
  assert.equal(reserved, 1);
} finally { console.error = originalError; }
console.log('PASS persistent failure protection and cached report');
const denied = interaction(wallet);
denied.channel.threads.create = async () => { throw Object.assign(Error('missing thread permission'), { code: 50013 }); };
let deniedScans = 0;
const previousError = console.error; console.error = () => {};
try {
  await createWalletHandler({ ...options, readPage: async () => { deniedScans++; } })(denied);
} finally { console.error = previousError; }
assert.equal(deniedScans, 0);
assert.match(denied.edits.at(-1), /建立公開討論串/);
process.env.DISCORD_WALLET_CHANNEL_ID = 'allowed-channel';
const wrongChannel = interaction(wallet);
wrongChannel.channelId = 'other-channel';
wrongChannel.reply = async function(payload) { this.first = payload; };
await createWalletHandler(options)(wrongChannel);
assert.match(wrongChannel.first.content, /MOD 工具箱頻道/);
assert.equal(wrongChannel.ackAt, undefined);
delete process.env.DISCORD_WALLET_CHANNEL_ID;
for (let iteration=0; iteration<10; iteration++) {
  let scans=0, reservations=0;
  const test = interaction(iteration===0 ? 'invalid' : wallet);
  const config = iteration!==1;
  const options = {
    configured:()=>config,
    readSnapshot:async()=>iteration===2?snapshot:null,
    reserveScan:async()=>{ reservations++; return iteration!==3; },
    readPage:async(_wallet,budget)=>{ scans++; if (iteration===4) return {waiting:true}; if (iteration===5) throw new Error('mock failure');
      if (iteration===6 || iteration===7 && scans===2) return {ready:true,snapshot};
      if (iteration===8) { budget.units+=40_000; return {ready:false,progress:{through:scans,target:100}}; }
      if (iteration===9) return {ready:false,progress:null};
      return {ready:false,progress:{through:scans,target:100}}; },
    renderPoster:()=>Buffer.from('PNG'), formatReport:()=> '摘要',
  };
  const begin=performance.now();
  const oldError=console.error; console.error=()=>{};
  try { await createWalletHandler(options)(test); } finally { console.error=oldError; }
  assert.ok(test.ackAt-begin < 3000, `iteration ${iteration}: initial response exceeded 3s`);
  assert.equal(test.first.content,'貓貓正在努力工作，請稍後... 完成後會拍拍通知');
  assert.equal(test.first.files[0].name,'cat-wait.gif');
  assert.equal(test.messages[0],'正在檢查地址與已儲存報表。');
  assert.equal(test.edits[0].content, `${test.first.content}\n進度與報表請見 <#thread-123>`);
  assert.ok(test.messages.every(message => typeof message === 'string' || !message.files?.some(file => file.name === 'cat-wait.gif')));
  assert.ok(scans <= 2 && reservations <= 1, `iteration ${iteration}: scan limit exceeded`);
  if (iteration <= 3) assert.equal(scans,0);
  if (iteration===2) { assert.equal(reservations,0); assert.equal(test.messages.at(-1).files[0].name,'wallet-report.png'); }
  if (iteration===2 || iteration===6) {
    assert.match(test.messages.at(-1).content, /^拍拍 <@123456789012345678>\n/);
    assert.deepEqual(test.messages.at(-1).allowedMentions, { users:['123456789012345678'] });
  }
  if (iteration===3) assert.match(test.edits.at(-1),/額度已用完/);
  if (iteration===4) assert.match(test.edits.at(-1),/兩次掃描仍未完成/);
  if (iteration===5) assert.match(test.edits.at(-1),/未完成/);
  if (iteration===6) assert.equal(test.messages.at(-1).files[0].name,'wallet-report.png');
  if (iteration===7) assert.equal(test.messages.at(-1).files[0].name,'wallet-report.png');
  if (iteration>=8) {
    assert.equal(scans,2);
    if (iteration===8) assert.match(test.edits.at(-1),/時間或 API 用量上限/);
    else assert.match(test.edits.at(-1),/兩次掃描仍未完成/);
  }
  console.log(`PASS iteration ${iteration+1}: ack ${Math.round(test.ackAt-begin)}ms, scans ${scans}`);
}
