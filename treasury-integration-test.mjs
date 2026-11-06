import assert from 'node:assert/strict';
import worker,{SIG} from './worker/index.js';
const wallet='0x'+'1'.repeat(40),box='0x'+'2'.repeat(40),treasury='0x'+'3'.repeat(40),usdc='0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',tx='0x'+'a'.repeat(64);
const w=n=>BigInt(n).toString(16).padStart(64,'0'),a=s=>'0x'+s.slice(2).padStart(64,'0');
const block=50637771,base={address:box,transactionHash:tx,blockNumber:'0x'+block.toString(16),logIndex:'0x1'};
const claim={...base,topics:[SIG.refund,'0x'+w(1),a(wallet)],data:'0x'+w(10000000)+w(1)};
const transfer={...base,address:usdc,logIndex:'0x2',topics:[SIG.transfer,a(treasury),a(wallet)],data:'0x'+w(10000000)};
let mode='good',historical=[];
function result(method,p){
 if(method==='eth_call'){
  const {data}=p[0];
  if(data==='0x44ff038f')return '0x'+w(1);
  if(data.startsWith('0x8df87e02'))return a(box);
  if(data==='0xd57f966b')return '0x'+w(0);
  if(data==='0x61d027b3'){historical.push(p[1]);return mode==='missing'?null:a(treasury);}
  if(data==='0x7b9e618d')return a(mode==='wrong-token'?box:usdc);
  throw Error('Unexpected selector '+data);
 }
 if(method==='eth_getLogs'){
  const q=p[0];
  if(q.topics[0]===SIG.treasuryUpdated)return mode==='change'?[{...base,topics:[SIG.treasuryUpdated,a(treasury)]}]:[];
  if(Array.isArray(q.address)&&Array.isArray(q.topics[0])&&q.topics[0].includes(SIG.refund))return [claim];
  return [];
 }
 if(method==='eth_getTransactionReceipt')return {status:'0x1',logs:[claim,transfer]};
 throw Error('Unexpected method '+method);
}
globalThis.fetch=async(url,opt)=>{const req=JSON.parse(opt.body);const answer=r=>({jsonrpc:'2.0',id:r.id,result:result(r.method,r.params)});return Response.json(Array.isArray(req)?req.map(answer):answer(req));};
for(mode of ['good','missing','change','wrong-token']){
 const r=await worker.fetch(new Request('https://local/api/scan?wallet='+wallet+'&from='+block+'&to='+block));
 assert.equal(r.status,200);const d=await r.json();
 assert.equal(d.events.filter(e=>e.category==='refund-confirmed').length,mode==='good'?1:0,mode);
 assert.equal(d.events.filter(e=>e.category==='refund-pending').length,mode==='good'?0:1,mode);
 if(mode==='good'){assert.equal(d.events.find(e=>e.category==='refund-confirmed').payer,treasury);assert.equal(d.events.find(e=>e.category==='refund-evidence').payer,treasury);}
}
assert(historical.includes('0x'+(block-1).toString(16)));
assert(historical.includes('0x'+block.toString(16)));
assert(!historical.includes('latest'));
console.log('PASS: scan API confirms treasury refund and leaves missing/changed/non-USDC payer evidence pending');
