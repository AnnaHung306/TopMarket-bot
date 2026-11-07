import assert from 'node:assert/strict';
import vm from 'node:vm';
import worker from './worker/index.js';
const html=await(await worker.fetch(new Request('https://local/'))).text(),script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
const nodes=new Map(),ctx={document:{getElementById:id=>{if(!nodes.has(id))nodes.set(id,{style:{setProperty(){}},dataset:{},focus(){}});return nodes.get(id);}}};vm.createContext(ctx);vm.runInContext(script,ctx);
for (const label of ['奪寶參與', '奪寶收入']) {
  assert(nodes.get('metrics').innerHTML.includes('<label>'+label+'</label><b>尚未查詢</b>'));
  assert(nodes.get('posterMetrics').innerHTML.includes('<span>'+label+'</span><b>尚未查詢</b>'));
}
const box='0x'+'1'.repeat(40),nft='0x'+'2'.repeat(40);
const common={contract:box,tx:'0xabc',logIndex:1,block:1,amount:null,raw:null};
const draw={...common,id:'draw',category:'pack',packKind:'card',requestId:'7',paidRaw:'10000000',feeRaw:'1000000',raw:'11000000',amount:11,paymentVerified:true,sourceStatus:'legacy-receipt'};
const won={...common,id:'won',category:'won',requestId:'7',winId:'8',collection:nft,tokenId:'9',block:2};
const kept={...common,id:'kept',category:'kept',winId:'8',collection:nft,tokenId:'9',block:3,acquisitionVerified:true,nftReceiptId:'0xabc:0x5'};
const receipt=(id,category,raw)=>({...common,id,category,raw,amount:Number(raw)/1e6});
const confirmed=receipt('buyback-receipt','buyback-claim-confirmed','9000000');
const disposal=receipt('disposal-receipt','kept-disposal-confirmed','4000000');
const purchase=receipt("purchase","purchaseGross","6000000");
const nonUsdcPurchase={...purchase,id:"non-usdc",raw:null,amount:null};
const unverifiedDraw={...draw,id:"unverified-draw",requestId:"99",paymentVerified:false,raw:"7000000"};
ctx.input=[draw,unverifiedDraw,won,kept,purchase,purchase,nonUsdcPurchase,receipt('refund','refund-confirmed','1000000'),receipt('sale','sales','2000000'),receipt('staking','staking-confirmed','3000000'),disposal,confirmed,confirmed,receipt('nominal','buyback','9000000'),receipt('pending','buyback-claim-pending','8000000')];
vm.runInContext("save=(text)=>{globalThis.exported=text;};state={events:input,wallet:'0xabc',started:true,from:1,through:4,complete:true,asOf:'test'};render();$('csv').onclick();",ctx);
assert.equal(nodes.get('cash').textContent,'+2.00','19.00 confirmed inflows less 11.00 for draws and 6.00 for a single USDC market purchase');
assert.equal(nodes.get('posterCash').textContent,'+2.00');
for (const id of ['cash', 'posterCash']) assert.equal(nodes.get(id).dataset.balance, 'profit');
assert(nodes.get('metrics').innerHTML.includes('data-metric="staking"><label>質押收益</label><b>7.00</b>'));
assert(nodes.get('posterMetrics').innerHTML.includes('data-metric="staking"><span>質押收益</span><b>7.00</b>'));
assert(nodes.get('metrics').innerHTML.includes('回購收入（已核實）'));
assert(nodes.get('posterMetrics').innerHTML.includes('<span>空投</span><b>查無已核實入帳</b>'));
assert(nodes.get('metrics').innerHTML.includes('<label>抽卡退款（已核實）</label><b>1.00</b>'));
assert(nodes.get('posterMetrics').innerHTML.includes('<span>抽卡退款</span><b>1.00</b>'));
assert(!html.includes('id="warning"'));
assert(!html.includes('收入小計：退款 + 市場銷售的實際 USDC 入帳。'));
function parse(line){const out=[];let text='',quoted=false;for(let i=0;i<line.length;i++){const c=line[i];if(c==='"'){if(quoted&&line[i+1]==='"'){text+='"';i++;}else quoted=!quoted;}else if(c===','&&!quoted){out.push(text);text='';}else text+=c;}out.push(text);return out;}
const rows=ctx.exported.trimEnd().split('\n').map(parse),header=rows.shift();
for(const row of rows)assert.equal(row.length,header.length);
const obj=row=>Object.fromEntries(header.map((key,i)=>[key,row[i]]));
const keptRow=rows.map(obj).find(e=>e.category==='kept');
assert.equal(keptRow.collection,nft);assert.equal(keptRow.token_id,'9');assert.equal(keptRow.linked_draw_id,'draw');
assert.equal(keptRow.acquisition_cost_raw,'11000000');assert.equal(keptRow.acquisition_cost_usdc,'11');
assert.equal(keptRow.acquisition_cost_status,'verified-acquisition');assert.equal(keptRow.nft_receipt_id,'0xabc:0x5');
vm.runInContext("$('json').onclick();",ctx);const json=JSON.parse(ctx.exported);
assert.equal(json.cashFlow.inflowsRaw, '19000000');
assert.equal(json.cashFlow.outflowsRaw, '17000000');
assert.equal(json.cashFlow.netRaw, '2000000');
assert.equal(json.cashFlow.stakingInflowRaw, '7000000');
assert.equal(json.cashFlow.keptDisposalRaw, '4000000');
assert(json.methodology.identifiedInflows.includes('winner buybacks'));
assert.equal(json.acquisitionCosts[0].acquisitionCostRaw,keptRow.acquisition_cost_raw);
ctx.snapshotTotals={pack:'75560000000',marketPurchases:'10000000',refund:'0',sales:'0',staking:'2403400000',keptDisposal:'23000000',
  buybackReceived:'72792000000',compensation:'44400000',campaignPrizes:'115700000',stakingCount:'1985',
  keptDisposalCount:'5',buybackCount:'3885',pendingPacks:'0',pendingBuybacks:'0',pendingStaking:'0',pendingKeptDisposal:'0',pendingRefunds:'0'};
vm.runInContext("state.summary={totals:snapshotTotals};render();$('json').onclick();delete state.summary;",ctx);
assert.equal(nodes.get('cash').textContent,'-191.50');
assert(nodes.get('posterMetrics').innerHTML.includes('<span>空投</span><b>160.10</b>'));
assert(!nodes.get('metrics').innerHTML.includes('抽卡退款'));
assert(!nodes.get('posterMetrics').innerHTML.includes('抽卡退款'));
for (const label of ['奪寶參與', '奪寶收入']) {
  assert(nodes.get('metrics').innerHTML.includes('<label>'+label+'</label><b>待更新</b><small>按「更新到最新區塊」</small>'));
  assert(nodes.get('posterMetrics').innerHTML.includes('<span>'+label+'</span><b>待更新</b>'));
}
assert.equal(JSON.parse(ctx.exported).cashFlow.raffleParticipationRaw,null);
assert.equal(JSON.parse(ctx.exported).cashFlow.raffleIncomeRaw,null);
assert(!nodes.get('metrics').innerHTML.includes('另有待核對'));
assert.equal(JSON.parse(ctx.exported).cashFlow.netRaw,'-191500000');
vm.runInContext("state.summary={totals:{...snapshotTotals,raffleParticipation:'0',raffleIncome:'0'}};render();$('json').onclick();delete state.summary;",ctx);
for (const label of ['奪寶參與', '奪寶收入']) {
  assert(nodes.get('posterMetrics').innerHTML.includes('<span>'+label+'</span><b>0.00</b>'));
}
assert.equal(JSON.parse(ctx.exported).cashFlow.raffleIncomeRaw,'0');
vm.runInContext("state.summary={totals:{...snapshotTotals,raffleParticipation:'3437000000',raffleIncome:'3415500000',raffleCards:'1'}};render();$('json').onclick();delete state.summary;",ctx);
assert.equal(nodes.get('posterCash').textContent,'-213.00');
assert(nodes.get('posterMetrics').innerHTML.includes('<span>奪寶參與</span><b>3,437.00</b>'));
assert(nodes.get('posterMetrics').innerHTML.includes('<span>奪寶收入</span><b>3,415.50 USDC ＋ 1 張卡</b>'));
assert.equal(JSON.parse(ctx.exported).cashFlow.raffleIncomeRaw,'3415500000');
ctx.cachedCampaign = { ...receipt('cached-campaign', 'campaign-payout', '517000000'),
  tx: '0xdc8ef68a54b213b6e9f17e3bbf147921b73277c100af6f5c2d071676da999f22' };
vm.runInContext("state.summary={totals:{...snapshotTotals,campaignOther:'517000000'},campaignPayouts:[cachedCampaign]};render();$('json').onclick();delete state.summary;",ctx);
assert.equal(nodes.get('cash').textContent,'+325.50');
assert(nodes.get('metrics').innerHTML.includes('<label>空投</label><b>677.10</b>'));
assert(nodes.get('posterMetrics').innerHTML.includes('<span>空投</span><b>677.10</b>'));
assert(nodes.get('rows').innerHTML.includes('https://basescan.org/tx/'+ctx.cachedCampaign.tx));
assert.equal(JSON.parse(ctx.exported).cashFlow.campaignOtherRaw,'517000000');
ctx.input=[draw];
vm.runInContext("state.events=input;render();",ctx);
for (const id of ['cash', 'posterCash']) assert.equal(nodes.get(id).dataset.balance, 'loss');
vm.runInContext("state.events=[];render();",ctx);
for (const id of ['cash', 'posterCash']) assert.equal(nodes.get(id).dataset.balance, 'neutral');
assert(nodes.get('posterMetrics').innerHTML.includes('<span>質押收益</span><b>查無入帳</b>'));
vm.runInContext("state.complete=false;state.scanError='test failure';render();",ctx);
assert(nodes.get('posterMetrics').innerHTML.includes('<span>質押收益</span><b>查詢失敗</b>'));
ctx.input=[receipt('pending-stake','staking-pending','200000')];
vm.runInContext("state.events=input;state.complete=true;delete state.scanError;render();",ctx);
assert(nodes.get('posterMetrics').innerHTML.includes('<span>質押收益</span><b>有事件待核對</b>'));
ctx.input=[receipt('small-stake','staking-treasury','1000')];
vm.runInContext("state.events=input;render();",ctx);
assert(nodes.get('posterMetrics').innerHTML.includes('<span>質押收益</span><b>0.001</b>'));
assert(!html.includes('id="example"'));
assert(!html.includes('id="range"'));
assert(!html.includes('id="refund"'));
ctx.input=[{...draw,sourceStatus:'adapter-source-unresolved',randomnessSource:box},won,kept];
vm.runInContext("state.events=input;$('csv').onclick();",ctx);
const pendingRows=ctx.exported.trimEnd().split('\n').slice(1).map(parse).map(obj);
assert.equal(pendingRows.find(x=>x.category==='kept').acquisition_cost_raw,'UNKNOWN');
assert.equal(pendingRows.find(x=>x.category==='kept').acquisition_cost_status,'unknown');
assert.equal(pendingRows.find(x=>x.category==='pack').source_status,'adapter-source-unresolved');
assert.equal(pendingRows.find(x=>x.category==='pack').randomness_source,box);
console.log('PASS: CSV/JSON cost linkage, unknown fields, HTML/poster net cash flow and buyback methodology agree');
