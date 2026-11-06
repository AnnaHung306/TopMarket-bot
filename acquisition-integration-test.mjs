import assert from 'node:assert/strict';
import worker,{SIG,linkAcquisitionCosts} from './worker/index.js';
const wallet='0x'+'1'.repeat(40),box='0x'+'2'.repeat(40),treasury='0x'+'3'.repeat(40),fee='0x'+'4'.repeat(40),nft='0x'+'5'.repeat(40),other='0x'+'6'.repeat(40),usdc='0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const w=n=>BigInt(n).toString(16).padStart(64,'0'),a=s=>'0x'+s.slice(2).padStart(64,'0');
const start=50637771,tx=n=>'0x'+w(n);
const log=(n,index,topics,data,address=box)=>({address,transactionHash:tx(n),blockNumber:'0x'+(start+n).toString(16),logIndex:'0x'+index.toString(16),topics,data});
const draw=log(1,1,[SIG.draw,'0x'+w(7),a(wallet)],'0x'+w(10000000)+w(1000000));
const won=log(2,1,[SIG.won,'0x'+w(8),'0x'+w(7),a(wallet)],'0x'+a(nft).slice(2)+w(9)+w(90000000));
const kept=log(3,1,[SIG.kept,'0x'+w(8),a(wallet)],'0x'+w(90000000));
const recycle=log(4,1,[SIG.buyback,'0x'+w(11),a(other)],'0x'+w(9000000)+a(wallet).slice(2)+w(1000000));
const transfer=(n,index,from,to,raw)=>log(n,index,[SIG.transfer,a(from),a(to)],'0x'+w(raw),usdc);
let mode='good';
function result(method,p){
 if(method==='eth_call'){
  const {data,to}=p[0];
  if(data==='0x44ff038f')return '0x'+w(to==='0x0e218eddfed2b6e482d2989d05c6db0ee41db2f2'?1:0);
  if(data.startsWith('0x8df87e02'))return a(box);
  if(data==='0xd57f966b')return '0x'+w(0);
  if(data==='0x61d027b3')return a(treasury);
  if(data==='0x7b9e618d')return a(usdc);
  if(data==='0x46904840')return a(fee);
  if(data.startsWith('0x80bfe883'))return a(wallet)+a(nft).slice(2)+w(9)+w(90000000)+a(other).slice(2)+w(1700000000)+w(1);
  throw Error('Unexpected selector '+data);
 }
 if(method==='eth_getLogs'){
  const q=p[0],sig=q.topics[0];
  if(Array.isArray(q.address)&&Array.isArray(sig)&&sig.includes(SIG.draw))return [draw,kept];
  if(Array.isArray(q.address)&&sig===SIG.won)return [won];
  if(Array.isArray(q.address)&&sig===SIG.buyback)return [mode==='self-winner'?{...recycle,topics:[SIG.buyback,'0x'+w(11),a(wallet)]}:recycle];
  return [];
 }
 if(method==='eth_getTransactionReceipt'){
  if(p[0]===tx(1))return {status:'0x1',logs:[draw,transfer(1,2,wallet,treasury,mode==='bad-payment'?9000000:10000000),transfer(1,3,wallet,fee,1000000),...(mode==='adapter'?[log(1,4,[SIG.requestVia,'0x'+w(7),a(other)],'0x')]:[])]};
  if(p[0]===tx(3))return {status:'0x1',logs:[kept,...(mode==='no-nft'?[]:[log(3,2,[SIG.transfer,a(other),a(wallet),'0x'+w(9)],'0x',nft)])]};
  if(p[0]===tx(4))return {status:'0x1',logs:[recycle,transfer(4,2,treasury,wallet,1000000),...(mode==='self-winner'?[transfer(4,4,treasury,wallet,9000000)]:[]),...(mode==='deferred'?[log(4,3,[SIG.payoutDeferred,a(wallet)],'0x'+w(1000000))]:[])]};
  throw Error('Unexpected receipt '+p[0]);
 }
 throw Error('Unexpected method '+method);
}
globalThis.fetch=async(url,opt)=>{const req=JSON.parse(opt.body);const answer=r=>({jsonrpc:'2.0',id:r.id,result:result(r.method,r.params)});return Response.json(Array.isArray(req)?req.map(answer):answer(req));};
for(mode of ['good','adapter','bad-payment','no-nft','deferred','self-winner']){
 const r=await worker.fetch(new Request('https://local/api/scan?wallet='+wallet+'&from='+start+'&to='+(start+5)));
 assert.equal(r.status,200,await r.clone().text());const d=await r.json(),cost=linkAcquisitionCosts(d.events)[0];
 assert.equal(cost.acquisitionCostRaw,['good','deferred','self-winner'].includes(mode)?'11000000':null,mode);
 assert.equal(d.events.filter(e=>e.category==='staking-confirmed').length,mode==='deferred'?0:1,mode);
 assert.equal(d.events.filter(e=>e.category==='buyback-claim-confirmed').length,mode==='self-winner'?1:0,mode);
 assert(!d.events.some(e=>e.category==='staking-confirmed'&&e.raw==='90000000'),'kept disposal proceeds excluded');
}
console.log('PASS: full scan API rewards and paid draw/NFT linkage, adapters, bad payments, missing NFT and deferred payout');
