import { updateScanStatus } from './scan-status.js';
import { renderWalletPoster } from './poster.js';
import { createGlassRefractionTools } from './glass-refraction.js';

export function reportClientScript(linkAcquisitionCosts) {
  return String.raw`${linkAcquisitionCosts.toString()}
${renderWalletPoster.toString()}
${updateScanStatus.toString()}
const glassRefractionTools = (${createGlassRefractionTools.toString()})();
const $=id=>document.getElementById(id);const labels={pack:'抽卡花費（已核實）',refund:'已確認退款實收',buyback:'回購名目額',buybackConfirmed:'回購收入（已核實）',kept:'保留卡片',sales:'銷售實收',staking:'質押收益（已核實）', 'staking-confirmed':'質押收益實收', 'staking-pending':'質押收益待核對', 'staking-evidence':'質押收益事件（不加總）', 'buyback-claim-confirmed':'回購實收證據', 'buyback-claim-pending':'回購待核對', 'buyback-claim-evidence':'回購事件（不加總）',holdings:'持倉卡片估值（參考）',subsidy:'補貼','refund-transfer':'指定地址退款',won:'抽中卡片',staked:'質押存入',unstaked:'質押取回',saleGross:'銷售名目額',purchaseGross:'市場買卡（事件金額）',selfTrade:'自成交（排除）',nftReceived:'NFT 轉入'};let state={events:[],wallet:'',complete:false,started:false},running=false,stopped=false;const money=(n,digits=2)=>n==null?'—':n.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:digits});
function totals() {
  const events = [...new Map(state.events.map(event => [event.id, event])).values()];
  const sum = (category, include = () => true) => events.filter(event => event.category === category && event.raw !== null && include(event))
    .reduce((total, event) => total + BigInt(event.raw), 0n);
  const count = category => events.filter(event => event.category === category).length;
  const pack = sum('pack', event => event.paymentVerified === true);
  const marketPurchases = sum('purchaseGross');
  const refund = sum('refund-confirmed');
  const sales = sum('sales');
  const staking = sum('staking-confirmed');
  const buybackReceived = sum('buyback-claim-confirmed');
  const inflows = refund + sales + staking + buybackReceived;
  const outflows = pack + marketPurchases;
  return {
    events, pack, marketPurchases, refund, sales, staking, buybackReceived, inflows, outflows,
    net: inflows - outflows,
    stakingKnown: count('staking-confirmed') > 0,
    buybackKnown: count('buyback-claim-confirmed') > 0,
    pendingPacks: events.filter(event => event.category === 'pack' && event.paymentVerified !== true).length,
    pendingBuybacks: count('buyback-claim-pending'),
    pendingStaking: count('staking-pending'),
    pendingRefunds: count('refund-pending'),
  };
}
function reportMetrics(totals, held) {
  const { started, complete, holdingsChecked } = state;
  const amount = raw => Number(raw) / 1e6;
  const priced = held.filter(asset => asset.referenceValue !== null);
  const holdings = holdingsChecked && held.length && priced.length === held.length
    ? priced.reduce((sum, asset) => sum + asset.referenceValue, 0)
    : null;
  const unit = started && !complete ? 'USDC · 部分' : 'USDC';
  const noResult = () => state.scanError ? '查詢失敗' : state.initializing ? '歷史回補中' : started ? '查詢未完成' : '尚未查詢';
  const receipt = (key, raw, verified, pending) => ({
    label: labels[key],
    value: verified ? money(amount(raw), 6) : pending ? '有事件待核對' : complete ? '查無入帳' : noResult(),
    note: verified ? unit + (pending ? ' · 另有待核對' : '') : '',
  });
  const metric = (key, value) => ({
    label: labels[key],
    value: value === null ? noResult() : money(value),
    note: value === null ? '' : unit,
  });
  const holdingsStatus = state.holdingsError ? '查詢失敗'
    : !holdingsChecked ? noResult()
    : held.length ? '部分卡片缺少報價'
    : (state.assets || []).some(asset => asset.status === 'unknown') ? '持有狀態待核對'
    : complete ? '查無符合的持倉' : '查詢未完成';
  return [
    started && totals.pendingPacks && totals.pack === 0n
      ? { label: labels.pack, value: '付款待核對', note: '' }
      : metric('pack', started ? amount(totals.pack) : null),
    metric('purchaseGross', started ? amount(totals.marketPurchases) : null),
    receipt('buybackConfirmed', totals.buybackReceived, totals.buybackKnown, totals.pendingBuybacks),
    { label: labels.subsidy, value: '待確認（未計入）', note: '缺少獨立鏈上依據' },
    receipt('staking', totals.staking, totals.stakingKnown, totals.pendingStaking),
    { label: labels.holdings, value: holdings === null ? holdingsStatus : money(holdings), note: holdings === null ? '' : '協議參考值 · 非報價' },
    metric('refund', started ? amount(totals.refund) : null),
    metric('sales', started ? amount(totals.sales) : null),
  ];
}
function render(){
const t=totals(),known=state.started,held=(state.assets||[]).filter(x=>['wallet','staked'].includes(x.status));
$('holdingCount').textContent=state.holdingsChecked?held.length+' 張（候選範圍）':'—';
const metrics=reportMetrics(t,held);
$('metrics').innerHTML=metrics.map(({label,value,note})=>'<div class="metric"><label>'+label+'</label><b>'+value+'</b><small>'+note+'</small></div>').join('');
$('posterMetrics').innerHTML=metrics.map(({label,value})=>'<div class="poster-row"><span>'+label+'</span><b>'+value+'</b></div>').join('');
const timestamp=Number.isFinite(Date.parse(state.asOf))
  ? ' · 資料截至台灣時間 ' + new Date(state.asOf).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false})
  : '';
const cash=known?(t.net>0n?'+':'')+money(Number(t.net)/1e6):'—';$('cash').textContent=cash;$('posterCash').textContent=cash;$('posterWallet').textContent=(['0x394d3f699e0082fe9c4970f0e3c2de248ea21eed','0xf867fa8db27a7d0f0eb72a46ea4cf6c6ead32b56'].includes(state.wallet)?'公開範例 · 非你的錢包 / ':'')+(state.wallet||'YOUR BASE WALLET');$('coverage').textContent=known?'區塊 '+state.from.toLocaleString()+'–'+state.through.toLocaleString()+' / '+(state.complete?'所選範圍已掃描':'掃描未完成')+' · USDC'+timestamp:'輸入錢包以讀取 Base 鏈上紀錄';$('posterWarning').textContent=state.complete?'已核實收入扣除已核實抽卡付款及市場買卡事件金額。持倉估值、鏈上手續費與其他平台交易未計入。':'資料未完整覆蓋。'+(known?'掃描未完成，金額僅為已讀取小計。':'請先查詢錢包。');$('posterDate').textContent=known?state.asOf+' · blocks '+state.from+'–'+state.through:'BASE / EVIDENCE FIRST';$('warning').textContent=!known?'尚未讀取鏈上資料。淨收支按已識別收入與支出計算。':(state.complete?'所選範圍已掃描。':'掃描尚未完整。')+' 退款待核對 '+t.pendingRefunds+' 筆，已排除收入；未唯一配對不代表未退款。質押待核對 '+t.pendingStaking+' 筆，回購待核對 '+t.pendingBuybacks+' 筆，抽卡付款待核對 '+t.pendingPacks+' 筆。淨收支 = 已確認退款 + 銷售實收 + 已核實質押分潤 + 已核實回購收入 − 已核實抽卡花費 − 市場買卡。抽卡採用已核對的 USDC 付款，買卡採用 USDC 成交事件金額；未涵蓋項目不列入。回購名目事件不另加總；質押只列已核實回收分潤，不含售出 NFT 本金。關聯抽卡支出為歷史購得支出，非目前持倉成本；延期提領、gas 與成本尚未完整覆蓋，不計損益。'+((state.warnings||[]).length?' '+state.warnings.length+' 筆來源查核未完整，詳見 JSON。':'');$('rows').innerHTML=t.events.length?t.events.slice().sort((a,b)=>b.block-a.block||b.logIndex-a.logIndex).slice(0,300).map(e=>'<tr><td>'+({'refund-pending':'退款待核對（未列收入）','refund-evidence':'退款事件（不加總）','refund-confirmed':'退款實收（已核對）'}[e.category]||labels[e.category]||e.category)+'</td><td>'+money(e.amount)+'</td><td>'+e.block+'</td><td><a target="_blank" rel="noopener" href="https://basescan.org/tx/'+e.tx+'">'+e.tx.slice(0,10)+'… ↗</a></td></tr>').join(''):'<tr><td colspan="4" class="empty">'+(known?'已掃描區間未找到匹配事件；不代表沒有其他活動':'鏈上證據將顯示於此')+'</td></tr>';$('assets').innerHTML=state.holdingsChecked?(held.length?'<div class="table-wrap"><table><thead><tr><th>資產</th><th>狀態</th><th>協議參考價</th><th>關聯抽卡支出</th><th>價格時間</th></tr></thead><tbody>'+held.map(x=>'<tr><td><a target="_blank" rel="noopener" href="https://basescan.org/token/'+x.collection+'?a='+x.tokenId+'">'+x.collection.slice(0,8)+'… #'+x.tokenId+'</a></td><td>'+(x.status==='staked'?'質押中':'錢包持有')+'</td><td>'+money(x.referenceValue)+'</td><td>'+money(x.drawAcquisitionCost)+'</td><td>'+(x.oracleTimestamp?new Date(x.oracleTimestamp*1000).toISOString().slice(0,10):'無報價時間')+'</td></tr>').join('')+'</tbody></table></div>':'<p class="caption">所選事件候選中未確認持倉；不代表整個錢包持倉為零。</p>'):'<p class="caption">'+(state.holdingsError?'持倉查核失敗：'+String(state.holdingsError).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])):'持倉尚未查核')+'</p>';for(const id of ['csv','json','download','print'])$(id).disabled=!known;}
async function checkHoldings(){const candidates=totals().events.filter(x=>x.collection&&x.tokenId&&['won','kept','staked','purchaseGross','nftReceived'].includes(x.category));const unique=[...new Map(candidates.map(x=>[x.collection+':'+x.tokenId,{collection:x.collection,tokenId:x.tokenId}])).values()];state.assets=[];for(let i=0;i<unique.length;i+=40){updateScanStatus('holdings', '正在核實卡片持有權 '+(i+1)+' / '+unique.length, blockProgress());const r=await fetch('/api/holdings',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({wallet:state.wallet,assets:unique.slice(i,i+40),block:state.head})});const d=await r.json();if(!r.ok)throw Error(d.error||'Holdings lookup failed');state.assets.push(...d.assets);}const costs=linkAcquisitionCosts(totals().events);state.assets=state.assets.map(asset=>{const matches=costs.filter(c=>c.collection===asset.collection&&c.tokenId===asset.tokenId);return {...asset,drawAcquisitionCost:matches.length===1?matches[0].acquisitionCost:null,costNote:'Observed draw acquisition expenditure only; current lot basis unknown'};});state.holdingsChecked=true;}
function clearPosterDownload(){const file=$('posterFile');if(file){URL.revokeObjectURL(file.href);file.remove();}$('posterImage')?.remove();}
async function get(path){const r=await fetch(path);const d=await r.json();if(!r.ok||d.error)throw Error(d.error||'資料讀取失敗');return d;}
async function loadReportIndex() {
  let init = await get('/api/init');
  while (init.initializing && !stopped) {
    state.initializing = true;
    const { start, through } = init.progress || {};
    const detail = through >= start && Number.isSafeInteger(through)
      ? '目前已補到區塊 ' + through.toLocaleString() + '。'
      : '正在初始化合約索引。';
    updateScanStatus('initializing', '首次歷史回補中。' + detail + '完成後會自動查詢錢包。');
    render();
    await new Promise(resolve => setTimeout(resolve, 10_000));
    if (!stopped) init = await get('/api/init');
  }
  state.initializing = false;
  return init;
}
async function prepareIndexedReport(init) {
  let through, lastHead = init.head;
  let deadline = Date.now() + 5 * 60_000;
  updateScanStatus('refreshing', '正在確認是否有新區塊…');
  while (!stopped && Date.now() < deadline) {
    const response = await fetch('/api/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ through }),
    });
    const sync = await response.json();
    if (!response.ok) throw Error(sync.error || '增量同步失敗');
    if (stopped) return null;
    if (sync.ready) return sync.head === init.head ? init : get('/api/init');
    through = sync.target;
    if (sync.head > lastHead) {
      lastHead = sync.head;
      deadline = Date.now() + 5 * 60_000;
    }
    updateScanStatus('refreshing', '全站正在同步新區塊，完成後會自動查詢錢包。');
    await new Promise(resolve => setTimeout(resolve, 2_000));
  }
  if (stopped) return null;
  throw Error('增量同步尚未完成，請稍後再查');
}
function blockProgress() {
  if (state.through === undefined) return null;
  return (state.through - state.from + 1) / (state.head - state.from + 1) * 100;
}

$('form').onsubmit = async event => {
  event.preventDefault();
  if (running) return;
  const wallet = $('wallet').value.trim();
  const refund = $('refund').value.trim();
  const range = $('range').value;
  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet) || refund && !/^0x[0-9a-fA-F]{40}$/.test(refund)) {
    updateScanStatus('error', '請輸入正確的 42 字元 Base 地址。');
    return;
  }

  running = true;
  stopped = false;
  clearPosterDownload();
  $('posterStatus').textContent = '';
  $('analyze').disabled = true;
  $('example').disabled = true;
  $('cancel').hidden = false;
  $('cancel').disabled = false;
  state = {wallet, refund, events:[], warnings:[], complete:false, started:false};
  updateScanStatus('preparing', '正在讀取 Base 區塊與工廠合約…');
  render();
  try {
    let init = await loadReportIndex();
    if (!stopped && init.refreshOnRequest) init = await prepareIndexedReport(init);
    if (stopped) {
      updateScanStatus('stopped', '已停止錢包查詢。');
      return;
    }
    Object.assign(state, {
      from: range === 'all' ? init.start : Math.max(init.start, init.head - Number(range) + 1),
      head: init.head, contracts: init.contracts, asOf: init.asOf, rpc: init.rpc,
    });
    state.through = state.from - 1;
    let size = init.indexed ? state.head - state.from + 1 : 10000;
    for (let from = state.from; from <= state.head && !stopped;) {
      const to = Math.min(from + size - 1, state.head);
      const span = from.toLocaleString() + '–' + to.toLocaleString();
      updateScanStatus('scanning', (init.indexed ? '正在讀取 Neon 歷史索引 ' : '正在讀取區塊 ') + span, blockProgress());
      let batch;
      try {
        batch = await get('/api/scan?wallet=' + wallet + '&from=' + from + '&to=' + to + '&refund=' + refund);
      } catch (error) {
        if (init.indexed || size <= 2000) throw error;
        size = Math.max(2000, Math.floor(size / 5));
        continue;
      }
      state.events.push(...batch.events);
      state.warnings.push(...(batch.warnings || []));
      state.started = true;
      state.through = to;
      from = to + 1;
      render();
    }

    state.complete = state.through === state.head;
    render();
    $('cancel').hidden = true;
    if (state.started) {
      try {
        await checkHoldings();
      } catch (error) {
        state.holdingsError = error.message;
        state.warnings.push('Holdings: ' + error.message);
      }
    }
    if (state.complete) {
      const message = state.holdingsError
        ? '所選區塊掃描完成。持倉查核未完成，詳情請見下方。'
        : '所選區塊掃描完成。請閱讀資料覆蓋限制。';
      updateScanStatus('complete', message, blockProgress());
    } else {
      updateScanStatus('stopped', state.started
        ? '可匯出已讀取區塊的部分報告。'
        : '尚未讀取區塊，沒有可匯出的報告。', blockProgress());
    }
    render();
  } catch (error) {
    state.scanError = error.message;
    updateScanStatus('error', '資料來源暫時無法完成：' + error.message + '。請稍後重試；未讀取資料不會填零。', blockProgress());
    render();
  } finally {
    running = false;
    $('analyze').disabled = false;
    $('example').disabled = false;
    $('cancel').hidden = true;
  }
};

$('cancel').onclick = () => {
  if (!running || stopped || $('cancel').hidden) return;
  stopped = true;
  $('cancel').disabled = true;
  updateScanStatus('stopping', '等目前的查詢結束後停止…', blockProgress());
};
$('example').onclick = () => {
  if (running) return;
  $('wallet').value = '0x394d3f699e0082fe9c4970f0e3c2de248ea21eed';
  $('range').value = 'all';
  updateScanStatus('idle', '已載入公開質押收益範例。按「分析錢包」讀取鏈上資料。');
  $('wallet').focus();
};
function save(content,name,type){const url=URL.createObjectURL(new Blob([content],{type}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}
$('json').onclick=()=>{
const t=totals();
const cashFlow=state.started?{inflowsRaw:t.inflows.toString(),outflowsRaw:t.outflows.toString(),netRaw:t.net.toString(),unit:'USDC base units (6 decimals)'}:null;
save(JSON.stringify({...state,events:t.events,cashFlow,acquisitionCosts:linkAcquisitionCosts(t.events),methodology:{currency:'USDC',identifiedInflows:'uniquely receipt-matched refunds plus receipt-confirmed direct marketplace sale receipts, recycle staking rewards and winner buybacks; unique transfer identities counted once; excludes nominal events and delayed withdrawals',identifiedOutflows:'Receipt-verified USDC draw payments and nominal USDC marketplace purchase amounts in the scanned blocks; excludes gas, other markets and unobserved expenses',realizedPnl:null,unrealizedPnl:null,holdingsValue:null,limitations:['delayed marketplace withdrawals not reconciled','staking receipts are verified lower bounds; deferred payouts unknown','linked draw acquisition expenditure is not current tax-lot basis','holdings candidates may be incomplete','protocol oracle references are not executable prices','gas excluded','unmatched and token-box buybacks excluded; NFT disposal proceeds incomplete']}},null,2),'top-market-report.json','application/json');
};$('csv').onclick=()=>{const e=totals().events,costs=new Map(linkAcquisitionCosts(e).map(c=>[c.keptId,c]));const header='category,amount_usdc,raw_amount,block,transaction,log_index,contract,request_or_win_id,receipt_or_claim_id,reason,collection,token_id,win_id,linked_draw_id,acquisition_cost_raw,acquisition_cost_usdc,acquisition_cost_status,acquisition_cost_note,payment_verified,randomness_source,source_status,nft_receipt_id';const rows=e.map(x=>{const c=costs.get(x.id);return [x.category,x.amount==null?'UNKNOWN':x.amount,x.raw??'UNKNOWN',x.block,x.tx,x.logIndex,x.contract,x.requestId||x.winId||'',x.receiptId||x.claimId||'',x.reason||'',x.collection||c?.collection||'',x.tokenId||c?.tokenId||'',x.winId||'',c?.drawId||'',c?(c.acquisitionCostRaw??'UNKNOWN'):'',c?(c.acquisitionCost??'UNKNOWN'):'',c?.costStatus||'',c?.reason||'',x.category==='pack'?(x.paymentVerified?'true':'UNKNOWN'):'',x.randomnessSource||'',x.sourceStatus||'',x.nftReceiptId||''].map(v=>'"'+String(v).replace(/"/g,'""')+'"').join(',');});save(header+'\n'+rows.join('\n'),'top-market-evidence.csv','text/csv;charset=utf-8');};$('print').onclick=()=>window.print();
let exportingPoster = false;
$('download').onclick = async () => {
  if (exportingPoster) return;
  exportingPoster = true;
  const report = state;
  try {
    const canvas = await renderWalletPoster($('poster'), $('report-background'), report.complete && !totals().pendingPacks, glassRefractionTools);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (state !== report) return;
    if (!blob) throw new Error('The browser could not encode the poster as PNG.');
    clearPosterDownload();

    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'top-market-wallet-poster.png';
    link.textContent = '儲存已產生的 PNG';
    link.id = 'posterFile';
    link.style.display = 'block';
    $('poster').append(link);

    const preview = document.createElement('img');
    preview.id = 'posterImage';
    preview.alt = '已產生的錢包報告海報';
    preview.src = url;
    preview.style.width = '100%';
    preview.style.marginTop = '16px';
    $('poster').append(preview);

    link.click();
    $('posterStatus').textContent = '海報已產生；若瀏覽器未自動下載，可點下方連結儲存。';
  } catch (error) {
    console.error('Poster export failed:', error);
    if (state === report) $('posterStatus').textContent = '無法產生 PNG，請再試一次。';
  } finally {
    exportingPoster = false;
  }
};
render();
`;
}
