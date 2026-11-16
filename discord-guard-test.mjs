import assert from 'node:assert/strict';
import { createWalletHandler } from './discord-interaction.mjs';

function interaction(address) {
  const edits = [];
  return { commandName:'wallet', isChatInputCommand:()=>true, options:{ getString:()=>address }, edits,
    async reply(payload) { this.replied = true; this.first = payload; this.ackAt = performance.now(); },
    async editReply(payload) { edits.push(payload); } };
}
const wallet='0x'+'a'.repeat(40), snapshot={ through: 99 };
for (let iteration=0; iteration<10; iteration++) {
  let scans=0, reservations=0;
  const test = interaction(iteration===0 ? 'invalid' : wallet);
  const config = iteration!==1;
  const options = {
    configured:()=>config,
    readSnapshot:async()=>iteration===2?snapshot:null,
    reserveScan:async()=>{ reservations++; return iteration!==3; },
    readPage:async()=>{ scans++; if (iteration===4) return {waiting:true}; if (iteration===5) throw new Error('mock failure');
      if (iteration===6) return {ready:true,snapshot}; return {ready:false,progress:{through:scans,target:100}}; },
    renderPoster:()=>Buffer.from('PNG'), formatReport:()=> '摘要',
  };
  const begin=performance.now();
  const oldError=console.error; console.error=()=>{};
  try { await createWalletHandler(options)(test); } finally { console.error=oldError; }
  assert.ok(test.ackAt-begin < 3000, `iteration ${iteration}: initial response exceeded 3s`);
  assert.equal(test.first.flags,64);
  assert.ok(scans <= 4 && reservations <= 4, `iteration ${iteration}: scan limit exceeded`);
  if (iteration <= 3) assert.equal(scans,0);
  if (iteration===2) { assert.equal(reservations,0); assert.equal(test.edits.at(-1).files[0].name,'wallet-report.png'); }
  if (iteration===3) assert.match(test.edits.at(-1),/額度已用完/);
  if (iteration===4) assert.match(test.edits.at(-1),/其他查詢處理/);
  if (iteration===5) assert.match(test.edits.at(-1),/未完成/);
  if (iteration===6) assert.equal(test.edits.at(-1).files[0].name,'wallet-report.png');
  if (iteration>=7) { assert.equal(scans,4); assert.match(test.edits.at(-1),/用量上限/); }
  console.log(`PASS iteration ${iteration+1}: ack ${Math.round(test.ackAt-begin)}ms, scans ${scans}`);
}
