import assert from 'node:assert/strict';import worker,{decode,decodeMarket,SIG} from './worker/index.js';
const w=n=>BigInt(n).toString(16).padStart(64,'0');const log=(s,data)=>({topics:[s,'0x'+w(1),'0x'+w(2)],data:'0x'+data.map(w).join(''),transactionHash:'0x'+'a'.repeat(64),logIndex:'0x1',blockNumber:'0x123',address:'0x'+'b'.repeat(40)});
assert.equal(decode(log(SIG.draw,[1000000,10000])).raw,'1010000');assert.equal(decode(log(SIG.tokenDraw,[1000000,10000])).raw,'1000000');assert.equal(decode(log(SIG.refund,[1000000,1])).category,'refund');assert.equal(decode(log(SIG.rescue,[1000000])).amount,1);assert.equal(decode(log(SIG.kept,[123])).amount,null);assert.equal(decode(log(SIG.buyback,[500000,1,2])).amount,.5);
assert.equal((await worker.fetch(new Request('https://local/api/scan?wallet=bad'))).status, 400);
const html = await (await worker.fetch(new Request('https://local/'))).text();
assert(html.includes('關聯抽卡支出為歷史購得支出，非目前持倉成本'));
assert(!html.includes('資料覆蓋與計算方法'));
new Function(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
console.log('PASS: six event decoders, bad-address rejection, HTML and client JS syntax');

const market={...log(SIG.sold,[]),topics:[SIG.sold,'0x'+w(123),'0x'+w(99),'0x'+w(5)],data:'0x'+w(4)+'000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda02913'+w(120000000)};
const sold=decodeMarket(market,'0x'+w(4).slice(-40));assert.equal(sold.category,'saleGross');assert.equal(sold.amount,120);assert.equal(sold.tokenId,'99');assert.equal(decodeMarket(market,'0x'+w(5).slice(-40)).category,'purchaseGross');assert.equal(decodeMarket(market,'0x'+w(6).slice(-40)),null);console.log('PASS: official marketplace seller/buyer non-indexed ABI and currency');
