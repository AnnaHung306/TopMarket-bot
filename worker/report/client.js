import { displayWalletTotals, summarizeWalletEvents, WALLET_HOLDINGS_PAGE_SIZE } from './accounting.js';
import { updateScanStatus } from './scan-status.js';
import { renderWalletPoster } from './poster.js';
import { createGlassRefractionTools } from './glass-refraction.js';

export function reportClientScript(linkAcquisitionCosts) {
  return String.raw`${linkAcquisitionCosts.toString()}
${renderWalletPoster.toString()}
${updateScanStatus.toString()}
${summarizeWalletEvents.toString()}
${displayWalletTotals.toString()}
const glassRefractionTools = (${createGlassRefractionTools.toString()})();
const $=id=>document.getElementById(id);const labels={pack:'抽卡花費（已核實）',refund:'抽卡退款（已核實）',buyback:'回購名目額',buybackConfirmed:'回購收入（已核實）',kept:'保留卡片','kept-disposal-confirmed':'留卡結算實收','kept-disposal-evidence':'留卡結算事件（不加總）','kept-disposal-pending':'留卡結算待核對',sales:'銷售實收',staking:'質押收益', 'staking-treasury':'質押收益', 'staking-confirmed':'質押收益實收', 'staking-pending':'質押收益待核對', 'staking-evidence':'質押收益事件（不加總）', 'buyback-claim-confirmed':'回購實收證據', 'buyback-claim-pending':'回購待核對', 'buyback-claim-evidence':'回購事件（不加總）',holdings:'持倉卡片估值（參考）',airdrop:'空投','campaign-payout':'活動入帳','refund-transfer':'指定地址退款',won:'抽中卡片',staked:'質押存入',unstaked:'質押取回',saleGross:'銷售名目額',purchaseGross:'市場買卡（事件金額）',selfTrade:'自成交（排除）',nftReceived:'NFT 轉入'};let state={events:[],wallet:'',complete:false,started:false},running=false,stopped=false;const money=(n,digits=2)=>n==null?'—':n.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:digits});
function totals() {
  const allEvents = [...state.events, ...(state.summary?.campaignPayouts || [])];
  const events = [...new Map(allEvents.map(event => [event.id, event])).values()];
  return displayWalletTotals(state.summary?.totals || summarizeWalletEvents(events), events);
}
Object.assign(labels, {
  raffleParticipation: '奪寶參與', raffleIncome: '奪寶收入',
  'raffle-participation': '奪寶參與', 'raffle-income': '奪寶收入',
  'raffle-refund': '奪寶退款', 'raffle-card': '奪寶獎品領取',
});
function holdingsSummary() {
  const assets = state.assets || [];
  const held = assets.filter(asset => ['wallet', 'staked'].includes(asset.status));
  const verified = state.complete && state.holdingsChecked && !state.holdingsError &&
    assets.length > 0 && assets.every(asset => ['wallet', 'staked', 'not-held'].includes(asset.status));
  const value = verified && held.every(asset => Number.isFinite(asset.referenceValue))
    ? held.reduce((sum, asset) => sum + asset.referenceValue, 0)
    : null;
  return { held, verified, value };
}
function reportMetrics(totals, holdings) {
  const { started, complete } = state;
  const airdrop = totals.compensation + totals.campaignPrizes + totals.campaignOther;
  const amount = raw => Number(raw) / 1e6;
  const unit = started && !complete ? 'USDC · 部分' : 'USDC';
  const noResult = () => state.scanError ? '查詢失敗' : started ? '查詢未完成' : '尚未查詢';
  const receipt = (key, raw, verified, pending, empty = '查無入帳') => ({
    key,
    label: labels[key],
    value: verified ? money(amount(raw), 6) : pending ? '有事件待核對' : complete ? empty : noResult(),
    note: verified ? unit + (pending ? ' · 另有待核對' : '') : '',
  });
  const metric = (key, value) => ({
    label: labels[key],
    value: value === null ? noResult() : money(value),
    note: value === null ? '' : unit,
  });
  const raffleMetric = (key, raw) => started && !totals.raffleKnown
    ? { label: labels[key], value: '待更新', note: state.summary?.rebuildRequired ? '按「重新核對舊版報表」' : '按「更新到最新區塊」' }
    : metric(key, started ? amount(raw) : null);
  const raffleIncome = raffleMetric('raffleIncome', totals.raffleIncome);
  if (totals.raffleCards > 0n) {
    const cards = totals.raffleCards + ' 張卡';
    raffleIncome.value = totals.raffleIncome > 0n ? raffleIncome.value + ' USDC ＋ ' + cards : cards;
    raffleIncome.note = '';
  }
  return [
    started && totals.pendingPacks && totals.pack === 0n
      ? { label: labels.pack, value: '付款待核對', note: '' }
      : metric('pack', started ? amount(totals.pack) : null),
    metric('purchaseGross', started ? amount(totals.marketPurchases) : null),
    receipt('buybackConfirmed', totals.buybackReceived, totals.buybackKnown, totals.pendingBuybacks),
    receipt('airdrop', airdrop, airdrop > 0n, false, '查無已核實入帳'),
    raffleMetric('raffleParticipation', totals.raffleParticipation - totals.raffleRefund),
    raffleIncome,
    receipt('staking', totals.stakingInflow, totals.stakingInflowKnown, totals.pendingStakingInflow),
    ...(holdings === null ? [] : [{ label: labels.holdings, value: money(holdings), note: '已查卡片 · 協議參考值' }]),
    ...(totals.refund > 0n ? [receipt('refund', totals.refund, true, false)] : []),
    metric('sales', started ? amount(totals.sales) : null),
  ];
}
function evidenceLabel(event) {
  const label = {'refund-pending':'退款待核對（未列收入）','refund-evidence':'退款事件（不加總）','refund-confirmed':'退款實收（已核對）'}[event.category] || labels[event.category] || event.category;
  return event.category.startsWith('raffle-') && /^\d+$/.test(event.requestId)
    ? label + '（第 ' + event.requestId + ' 期）' : label;
}
function render(){
clearPosterDownload();
const t=totals(),known=state.started,{held,verified,value}=holdingsSummary();
$('sharePoster').disabled=!known;
$('holdingCountMetric').hidden=!verified;
$('holdingCount').textContent=verified?held.length+' 張（已查卡片）':'';
$('holdingsSection').hidden=!state.holdingsChecked||Boolean(state.holdingsError)||!held.length;
$('update').hidden=!state.summary;
$('update').textContent=state.summary?.rebuildRequired?'重新核對舊版報表（會查鏈）':'更新到最新區塊';
$('fullEvidence').hidden=!state.summary||state.fullEvidence;
$('json').textContent=state.summary&&!state.fullEvidence?'匯出收支摘要 JSON':'匯出完整 JSON';
const metrics=reportMetrics(t,value);
const stakingAttribute=key=>key==='staking'?' data-metric="staking"':'';
$('metrics').innerHTML=metrics.map(({key,label,value,note})=>'<div class="metric"'+stakingAttribute(key)+'><label>'+label+'</label><b>'+value+'</b><small>'+note+'</small></div>').join('');
$('posterMetrics').innerHTML=metrics.map(({key,label,value})=>{
  const posterLabel=label.replace(/（(?:已核實|事件金額|參考)）$/, '');
  return '<div class="poster-row"'+stakingAttribute(key)+'><span>'+posterLabel+'</span><b>'+value+'</b></div>';
}).join('');
const cash=known?(t.net>0n?'+':'')+money(Number(t.net)/1e6):'—';
const balance=!known||t.net===0n?'neutral':t.net>0n?'profit':'loss';
for(const id of ['cash','posterCash']){
  const amount=$(id);
  amount.textContent=cash;
  amount.dataset.balance=balance;
}
const timestamp=Number.isFinite(Date.parse(state.asOf))
  ? ' · 資料截至台灣時間 ' + new Date(state.asOf).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false})
  : '';
$('posterWallet').textContent=(['0xe618f35dfbf4ab79b02b315fd60c69cd289ef75d','0x394d3f699e0082fe9c4970f0e3c2de248ea21eed','0xf867fa8db27a7d0f0eb72a46ea4cf6c6ead32b56'].includes(state.wallet)?'公開範例 · 非你的錢包 / ':'')+(state.wallet||'YOUR BASE WALLET');$('coverage').textContent=known?'區塊 '+state.from.toLocaleString()+'–'+state.through.toLocaleString()+' / '+(state.complete?(state.summary?.rebuildRequired?'已存舊版收支摘要':state.cacheHit?'已存收支摘要':'完整收支已核對'):'掃描未完成')+' · USDC'+timestamp:'輸入錢包以讀取 Base 鏈上紀錄';$('posterDate').textContent=known?state.asOf+' · blocks '+state.from+'–'+state.through:'BASE / EVIDENCE FIRST';$('rows').innerHTML=t.events.length?t.events.slice().sort((a,b)=>b.block-a.block||b.logIndex-a.logIndex).slice(0,300).map(e=>'<tr><td>'+evidenceLabel(e)+'</td><td>'+money(e.amount)+'</td><td>'+e.block+'</td><td><a target="_blank" rel="noopener" href="https://basescan.org/tx/'+e.tx+'">'+e.tx.slice(0,10)+'… ↗</a></td></tr>').join(''):'<tr><td colspan="4" class="empty">'+(state.summary&&!state.fullEvidence?'目前顯示已存收支。需要完整逐筆證據時，可另行核對。':known?'已掃描區間未找到匹配事件；不代表沒有其他活動':'鏈上證據將顯示於此')+'</td></tr>';$('assets').innerHTML=state.holdingsChecked?(held.length?'<div class="table-wrap"><table><thead><tr><th>資產</th><th>狀態</th><th>協議參考價</th><th>關聯抽卡支出</th><th>價格時間</th></tr></thead><tbody>'+held.map(x=>'<tr><td><a target="_blank" rel="noopener" href="https://basescan.org/token/'+x.collection+'?a='+x.tokenId+'">'+x.collection.slice(0,8)+'… #'+x.tokenId+'</a></td><td>'+(x.status==='staked'?'質押中':'錢包持有')+'</td><td>'+money(x.referenceValue)+'</td><td>'+money(x.drawAcquisitionCost)+'</td><td>'+(x.oracleTimestamp?new Date(x.oracleTimestamp*1000).toISOString().slice(0,10):'無報價時間')+'</td></tr>').join('')+'</tbody></table></div>':'<p class="caption">所選事件候選中未確認持倉；不代表整個錢包持倉為零。</p>'):'<p class="caption">'+(state.holdingsError?'持倉查核失敗：'+String(state.holdingsError).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])):state.summary?'本次只讀取收支摘要，持倉未重新查核。':'持倉尚未查核')+'</p>';for(const id of ['csv','json','download','print'])$(id).disabled=!known;
if(state.summary&&!state.fullEvidence)$('csv').disabled=true;}
async function checkHoldings(){
  const events=totals().events;
  const candidates=events.filter(x=>x.collection&&x.tokenId&&['won','kept','staked','purchaseGross','nftReceived'].includes(x.category));
  const unique=[...new Map(candidates.map(x=>[x.collection+':'+x.tokenId,{collection:x.collection,tokenId:x.tokenId}])).values()];
  const pageSize=document.documentElement?.dataset?.walletCache==='true'?${WALLET_HOLDINGS_PAGE_SIZE}:40;
  const pages=[];
  for(let i=0;i<unique.length;i+=pageSize)pages.push(unique.slice(i,i+pageSize));
  state.assets=[];
  for(let i=0;i<pages.length;i+=3){
    updateScanStatus('holdings','正在核實卡片持有權 '+(i*pageSize+1)+' / '+unique.length,blockProgress());
    const results=await Promise.all(pages.slice(i,i+3).map(async assets=>{
      const response=await fetch('/api/holdings',{method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({wallet:state.wallet,assets,block:state.head})});
      const data=await response.json();
      if(!response.ok)throw Error(data.error||'Holdings lookup failed');
      return data;
    }));
    for(const data of results){
      state.assets.push(...data.assets);
      state.alchemyUnits+=data.usage?.units||0;
    }
  }
  const costs=new Map();
  for(const cost of linkAcquisitionCosts(events)){
    const key=cost.collection+':'+cost.tokenId;
    costs.set(key,costs.has(key)?null:cost.acquisitionCost);
  }
  state.assets=state.assets.map(asset=>({...asset,drawAcquisitionCost:costs.get(asset.collection+':'+asset.tokenId)??null,
    costNote:'Observed draw acquisition expenditure only; current lot basis unknown'}));
  state.holdingsChecked=true;
}
function clearPosterDownload() {
  posterRevision++;
  $('posterStatus').textContent = '';
  if (!preparedPoster) return;
  const { link, preview } = preparedPoster;
  URL.revokeObjectURL(link.href);
  link.remove();
  preview.remove();
  preparedPoster = null;
}
async function get(path){const r=await fetch(path);const d=await r.json();if(!r.ok||d.error)throw Error(d.error||'資料讀取失敗');return d;}
function blockProgress(report = state) {
  if (report.through === undefined) return null;
  return (report.through - report.from + 1) / (report.head - report.from + 1) * 100;
}

function newWalletReport(wallet) {
  return {wallet, events:[], warnings:[], complete:false, started:false, alchemyUnits:0};
}

async function readWalletCache(report, afterBlock, previous) {
  const { wallet } = report;
  let evidenceEnd, contiguous = true, resumed = false;
  while (!stopped) {
    const response = await fetch('/api/wallet-cache', {
      method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ wallet, afterBlock }),
    });
    const data = await response.json();
    if (!response.ok) throw Error(data.error || '錢包快取讀取失敗');
    report.alchemyUnits += data.usage?.units || 0;
    if (data.page) {
      if (evidenceEnd === undefined) resumed = data.progress?.resumed === true;
      if (evidenceEnd !== undefined && data.page.from !== evidenceEnd + 1) contiguous = false;
      report.evidenceFrom ??= data.page.from;
      report.evidenceThrough = evidenceEnd = data.page.to;
      for (const event of data.page.events) report.events.push(event);
      report.warnings.push(...(data.page.warnings || []));
    }
    if (data.ready) {
      const summary = data.snapshot;
      Object.assign(report, {
        summary, from: summary.start, head: summary.through, through: summary.through,
        asOf: summary.asOf, started: true, complete: true, cacheHit: data.cached && evidenceEnd === undefined,
        fullEvidence: contiguous && report.evidenceFrom === summary.start && evidenceEnd === summary.through,
      });
      if (report.cacheHit && previous.wallet === wallet && previous.summary?.blockHash === summary.blockHash) {
        for (const field of ['events', 'evidenceFrom', 'evidenceThrough', 'fullEvidence', 'assets', 'holdingsChecked', 'holdingsError', 'warnings']) report[field] = previous[field];
      }
      return resumed;
    }
    if (data.progress) Object.assign(report, {
      from: data.progress.from, head: data.progress.target, through: data.progress.through, asOf: data.progress.asOf,
    });
    const scanningHistory = afterBlock === undefined || previous.summary?.rebuildRequired;
    updateScanStatus('scanning', data.waiting ? '此錢包正在核對，等待共用結果。'
      : scanningHistory ? '正在核對完整錢包活動…' : '正在核對檢查點之後的錢包活動…', blockProgress(report));
    if (data.waiting) await new Promise(resolve => setTimeout(resolve, 1_500));
  }
  return false;
}

async function analyzeWallet(event, afterBlock, evidenceOnly = false) {
  event?.preventDefault();
  if (running) return;
  const wallet = $('wallet').value.trim().toLowerCase();
  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
    updateScanStatus('error', '請輸入正確的 42 字元 Base 地址。');
    return;
  }

  const previous = state;
  if (afterBlock !== undefined && previous.wallet !== wallet) return;
  running = true;
  stopped = false;
  $('analyze').disabled = true;
  $('update').disabled = true;
  $('fullEvidence').disabled = true;
  $('cancel').hidden = false;
  $('cancel').disabled = false;
  const useCache = document.documentElement?.dataset?.walletCache === 'true' && !evidenceOnly;
  const report = newWalletReport(wallet);
  if (!useCache || afterBlock === undefined || !previous.summary) state = report;
  const preparing = afterBlock === undefined ? '正在檢查已存錢包摘要…' : '正在核對最新區塊…';
  updateScanStatus('preparing', useCache ? preparing : '正在讀取 Base 區塊與工廠合約…');
  render();
  try {
    if (useCache) {
      const resumed = await readWalletCache(report, afterBlock, previous);
      if (report.complete) state = report;
      let needsRefresh = resumed || (afterBlock === undefined && report.cacheHit);
      while (needsRefresh && !stopped) {
        const message = state.summary.rebuildRequired
          ? '已顯示舊版報表，正在重新核對完整歷史…'
          : '已顯示上次儲存的報表，正在核對最新區塊…';
        updateScanStatus('scanning', message);
        render();
        const refreshed = newWalletReport(wallet);
        refreshed.alchemyUnits = state.alchemyUnits;
        needsRefresh = await readWalletCache(refreshed, state.summary.through, state);
        if (refreshed.complete) state = refreshed;
      }
    } else {
      const init = await get('/api/init');
      if (stopped) {
        updateScanStatus('stopped', '已停止錢包查詢。');
        return;
      }
      Object.assign(state, {
        from: init.start,
        head: init.head, contracts: init.contracts, asOf: init.asOf, rpc: init.rpc, alchemyUnits: init.usage?.units || 0,
      });
      state.through = state.from - 1;
      let size = init.directWallet ? state.head - state.from + 1 : 10000;
      for (let from = state.from; from <= state.head && !stopped;) {
        const to = Math.min(from + size - 1, state.head);
        const span = from.toLocaleString() + '–' + to.toLocaleString();
        updateScanStatus('scanning', (init.directWallet ? '正在核對錢包活動 ' : '正在讀取區塊 ') + span, blockProgress());
        let batch;
        try {
          batch = await get('/api/scan?wallet=' + wallet + '&from=' + from + '&to=' + to + (init.directWallet ? '&mode=wallet' : ''));
        } catch (error) {
          if (init.directWallet || size <= 2000) throw error;
          size = Math.max(2000, Math.floor(size / 5));
          continue;
        }
        const through = batch.to;
        if (!Number.isSafeInteger(through) || through < from || through > to) {
          throw Error('報表分頁區塊無效');
        }
        state.events.push(...batch.events);
        state.warnings.push(...(batch.warnings || []));
        state.alchemyUnits += batch.usage?.units || 0;
        state.started = true;
        state.through = through;
        from = through + 1;
        if (!init.directWallet) render();
      }

      state.complete = state.through === state.head;
    }
    render();
    $('cancel').hidden = true;
    if (state.started && !state.cacheHit && (!state.summary || state.fullEvidence)) {
      try {
        await checkHoldings();
      } catch (error) {
        state.holdingsError = error.message;
        state.warnings.push('Holdings: ' + error.message);
      }
    }
    if (stopped && useCache && state.summary) {
      updateScanStatus('stopped', '已停止更新，目前顯示已儲存的報表。');
    } else if (state.complete) {
      const message = state.summary?.rebuildRequired ? '已讀取舊版收支摘要。重新核對後可更新交易分類。'
        : state.cacheHit
        ? state.alchemyUnits ? '已核對最新區塊，沒有需要更新的範圍。' : '已讀取上次收支摘要，這次未向 Alchemy 查詢。'
        : state.summary && state.evidenceFrom === undefined ? '已更新累計收支。'
        : state.summary && !state.fullEvidence ? '已更新累計收支。逐筆證據僅含本次讀取的區塊。'
        : state.holdingsError ? '歷史收支已核對，持倉查核未完成。'
        : '已核對完整期間。請閱讀資料覆蓋限制。';
      updateScanStatus('complete', message, blockProgress());
    } else {
      updateScanStatus('stopped', state.started
        ? '可匯出已讀取區塊的部分報告。'
        : '尚未讀取區塊，沒有可匯出的報告。', blockProgress());
    }
    render();
  } catch (error) {
    state.scanError = error.message;
    if (useCache && state.summary) {
      updateScanStatus('error', '更新未完成，目前顯示已儲存的報表。' + error.message + '。');
    } else {
      updateScanStatus('error', '資料來源暫時無法完成：' + error.message + '。請稍後重試；未讀取資料不會填零。', blockProgress());
    }
    render();
  } finally {
    running = false;
    $('analyze').disabled = false;
    $('update').disabled = false;
    $('fullEvidence').disabled = false;
    $('cancel').hidden = true;
  }
}
$('form').onsubmit = event => analyzeWallet(event);
$('update').onclick = () => analyzeWallet(null, state.summary?.through);
$('fullEvidence').onclick = () => analyzeWallet(null, undefined, true);

$('cancel').onclick = () => {
  if (!running || stopped || $('cancel').hidden) return;
  stopped = true;
  $('cancel').disabled = true;
  updateScanStatus('stopping', '等目前的查詢結束後停止…', blockProgress());
};
function save(content,name,type){const url=URL.createObjectURL(new Blob([content],{type}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}
$('json').onclick=()=>{
const t=totals();
const cashFlow=state.started?{inflowsRaw:t.inflows.toString(),outflowsRaw:t.outflows.toString(),netRaw:t.net.toString(),stakingInflowRaw:t.stakingInflow.toString(),keptDisposalRaw:t.keptDisposal.toString(),compensationRaw:t.compensation.toString(),campaignPrizesRaw:t.campaignPrizes.toString(),campaignOtherRaw:t.campaignOther.toString(),
  raffleParticipationRaw:t.raffleKnown?t.raffleParticipation.toString():null,
  raffleIncomeRaw:t.raffleKnown?t.raffleIncome.toString():null,
  raffleRefundRaw:t.raffleKnown?t.raffleRefund.toString():null,
  raffleCards:t.raffleKnown?t.raffleCards.toString():null,unit:'USDC base units (6 decimals)'}:null;
save(JSON.stringify({...state,events:t.events,cashFlow,acquisitionCosts:linkAcquisitionCosts(t.events),methodology:{currency:'USDC',identifiedInflows:'uniquely receipt-matched refunds plus receipt-confirmed direct marketplace sale receipts, staking income, winner buybacks, verified campaign payouts and raffle buybacks or refunds; unique transfer identities counted once; excludes nominal events and delayed withdrawals',identifiedOutflows:'Receipt-verified USDC draw payments and nominal USDC marketplace purchase amounts and confirmed raffle entries in the scanned blocks; excludes gas, other markets and unobserved expenses',realizedPnl:null,unrealizedPnl:null,holdingsValue:null,limitations:['delayed marketplace withdrawals not reconciled','unpaid staking payouts are not included','linked draw acquisition expenditure is not current tax-lot basis','holdings candidates may be incomplete','protocol oracle references are not executable prices','gas excluded','unmatched buybacks excluded; NFT disposal proceeds incomplete']}},null,2),'top-market-report.json','application/json');
};$('csv').onclick=()=>{const e=totals().events,costs=new Map(linkAcquisitionCosts(e).map(c=>[c.keptId,c]));const header='category,amount_usdc,raw_amount,block,transaction,log_index,contract,request_or_win_id,receipt_or_claim_id,reason,collection,token_id,win_id,linked_draw_id,acquisition_cost_raw,acquisition_cost_usdc,acquisition_cost_status,acquisition_cost_note,payment_verified,randomness_source,source_status,nft_receipt_id';const rows=e.map(x=>{const c=costs.get(x.id);return [x.category,x.amount==null?'UNKNOWN':x.amount,x.raw??'UNKNOWN',x.block,x.tx,x.logIndex,x.contract,x.requestId||x.winId||'',x.receiptId||x.claimId||'',x.reason||'',x.collection||c?.collection||'',x.tokenId||c?.tokenId||'',x.winId||'',c?.drawId||'',c?(c.acquisitionCostRaw??'UNKNOWN'):'',c?(c.acquisitionCost??'UNKNOWN'):'',c?.costStatus||'',c?.reason||'',x.category==='pack'?(x.paymentVerified?'true':'UNKNOWN'):'',x.randomnessSource||'',x.sourceStatus||'',x.nftReceiptId||''].map(v=>'"'+String(v).replace(/"/g,'""')+'"').join(',');});save(header+'\n'+rows.join('\n'),'top-market-evidence.csv','text/csv;charset=utf-8');};$('print').onclick=()=>window.print();
const posterFilename = 'top-market-wallet-poster.png';
const shareButton = $('sharePoster');
shareButton.hidden = typeof globalThis.navigator?.share !== 'function' ||
  !navigator.canShare?.({ files: [new File([], posterFilename, { type: 'image/png' })] });
let posterRevision = 0;
let preparedPoster = null;
let preparingPoster = false;

async function preparePoster() {
  const canvas = await renderWalletPoster($('poster'), $('report-background'), state.complete && !totals().pendingPacks, glassRefractionTools);
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('The browser could not encode the poster as PNG.');
  return blob;
}

async function exportPoster(share) {
  if (preparingPoster) return;
  const revision = posterRevision;
  try {
    if (!preparedPoster) {
      preparingPoster = true;
      $('posterStatus').textContent = '正在產生高畫質海報…';
      const blob = await preparePoster();
      if (posterRevision !== revision) return;
      const file = new File([blob], posterFilename, { type: blob.type });
      const url = URL.createObjectURL(file);
      const link = document.createElement('a');
      link.href = url;
      link.download = posterFilename;
      link.textContent = '儲存已產生的 PNG';
      link.id = 'posterFile';
      link.style.display = 'block';

      const preview = document.createElement('img');
      preview.id = 'posterImage';
      preview.alt = '已產生的錢包報告海報';
      preview.src = url;
      preview.style.width = '100%';
      preview.style.marginTop = '16px';
      $('poster').append(link, preview);
      preparedPoster = { file, link, preview };
    }
  } catch (error) {
    console.error('Poster export failed:', error);
    if (posterRevision === revision) $('posterStatus').textContent = '無法產生 PNG，請再試一次。';
    return;
  } finally {
    preparingPoster = false;
  }

  if (!share) {
    preparedPoster.link.click();
    $('posterStatus').textContent = '海報已產生；若瀏覽器未自動下載，可點下方連結儲存。';
    return;
  }

  if (navigator.userActivation?.isActive === false) {
    $('posterStatus').textContent = '海報已產生。再點一下「儲存到相簿／分享」即可開啟選單。';
    return;
  }

  $('posterStatus').textContent = '在系統分享選單選擇「儲存影像」即可存到 iPhone 相簿。';
  try {
    await navigator.share({ files: [preparedPoster.file] });
  } catch (error) {
    if (posterRevision !== revision || error.name === 'AbortError') return;
    console.error('Poster sharing failed:', error);
    $('posterStatus').textContent = '無法開啟分享選單。可重新點選，或用下方連結下載 PNG。';
  }
}
$('download').onclick = () => exportPoster(false);
shareButton.onclick = () => exportPoster(true);
render();
`;
}
