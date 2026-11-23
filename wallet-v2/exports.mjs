import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { money, SCOPES, OUTCOME_LABELS, DELIVERY_LABELS, displayTime } from './model.mjs';

const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const time = seconds => seconds == null ? '' : new Date(seconds * 1000).toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' });
const csvCell = value => {
  let text = String(value ?? '');
  if (/^[\s]*[=+@-]/.test(text) && !/^-?\d+(?:\.\d+)?$/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
};
export function csvReport(report) {
  const columns = ['record_type', 'id', 'activity', 'pool_id', 'origin_pool_id', 'time_taipei', 'category', 'direction',
    'raw_usdc', 'display_usdc', 'proceeds_raw', 'acquisition_expenditure_raw', 'realized_difference_raw',
    'stake_collection', 'stake_token_id', 'stake_reference_raw', 'target_collection', 'target_token_id',
    'target_reference_raw', 'reference_decimals', 'chance_bps', 'edge_bps', 'outcome', 'delivery', 'transaction',
    'settlement_transaction', 'stake_card_name', 'target_card_name', 'transaction_url', 'evidence', 'verification', 'note'];
  const rows = report.metrics.map(metric => ({ record_type: 'metric', id: metric.key, category: metric.kind,
    raw_usdc: metric.raw, display_usdc: money(metric.raw), note: metric.label }));
  for (const [type, groups] of [['activity-summary', report.analysis.byActivity], ['pool-summary', report.analysis.byPool]]) {
    for (const group of groups) rows.push({ record_type: type, id: group.id, raw_usdc: group.netRaw,
      display_usdc: money(group.netRaw), note: `${group.name}; inflow_raw=${group.inRaw}; outflow_raw=${group.outRaw}; count=${group.count}` });
  }
  for (const flow of report.flows) rows.push({ record_type: 'cash', id: flow.id, activity: flow.activity,
    pool_id: flow.poolId, origin_pool_id: flow.originPoolId, time_taipei: time(flow.timestamp), category: flow.category,
    direction: flow.direction, raw_usdc: flow.raw, display_usdc: money(flow.raw), transaction: flow.tx,
    evidence: flow.proofIds.join(';'), verification: flow.verification });
  for (const record of report.realized) rows.push({ record_type: 'realized-expenditure', id: record.id,
    activity: record.activity, pool_id: record.poolId, origin_pool_id: record.originPoolId, time_taipei: time(record.timestamp),
    proceeds_raw: record.proceedsRaw, acquisition_expenditure_raw: record.costRaw, realized_difference_raw: record.pnlRaw,
    transaction: record.tx, evidence: record.evidence.join(';'), note: record.reason });
  for (const spin of report.upgrade.spins) rows.push({ record_type: 'upgrade', id: spin.id, activity: 'upgrade',
    pool_id: spin.poolId, time_taipei: time(spin.request.timestamp), stake_collection: spin.request.stakeCollection,
    stake_token_id: spin.request.stakeTokenId, stake_reference_raw: spin.request.stakeValueRaw,
    target_collection: spin.request.targetCollection, target_token_id: spin.request.targetTokenId,
    target_reference_raw: spin.request.targetValueRaw, reference_decimals: spin.request.valueDecimals,
    chance_bps: spin.request.chanceBps, edge_bps: spin.request.edgeBps, outcome: spin.status, delivery: spin.delivery,
    transaction: spin.request.tx, settlement_transaction: spin.result?.tx, stake_card_name: spin.stakeLabel, target_card_name: spin.targetLabel,
    evidence: [spin.stakeTransferId, spin.deliveryTransferId].filter(Boolean).join(';'), note: '參考估值不是現金收入；參與按申請時間，收益按結算時間' });
  for (const row of report.pending) rows.push({ record_type: 'unresolved', id: row.id, activity: row.activity,
    time_taipei: time(row.timestamp), category: row.category, transaction: row.tx, verification: 'unresolved', note: row.reason });
  for (const source of report.coverage) rows.push({ record_type: 'coverage', id: source.key,
    verification: `${source.status};complete=${Boolean(source.complete)}`, note: source.reason || '' });
  for (const row of rows) if (/^0x[\da-f]{64}$/i.test(row.transaction || '')) row.transaction_url = `https://basescan.org/tx/${row.transaction}`;
  return '\ufeff' + [columns, ...rows.map(row => columns.map(column => row[column]))].map(row => row.map(csvCell).join(',')).join('\r\n');
}

export async function htmlReport(report) {
  const font = (await readFile(new URL('../assets/NotoSansTC.ttf', import.meta.url))).toString('base64');
  const cards = report.metrics.map(metric => `<section class="metric glass" data-key="${metric.key}" data-raw="${metric.raw ?? 'unknown'}"><span>${escape(metric.label)}</span><strong>${escape(money(metric.raw))}</strong><small>${metric.kind === 'reference' ? 'USDC 參考價值 · 非現金' : metric.kind === 'expenditure' ? 'USDC · 未知成本不當成零' : 'USDC'}</small></section>`).join('');
  const u = report.upgrade;
  const upgrade = ['all', 'upgrade'].includes(report.filter.scope) ? `<section class="panel glass"><h2>卡牌升級</h2><div class="stats">
    <div><b>${u.requests}</b><span>本期申請</span></div><div><b>${u.won} / ${u.lost}</b><span>本期結算成功 / 失敗</span></div>
    <div><b>${u.winRate == null ? '—' : (u.winRate * 100).toFixed(2) + '%'}</b><span>本期結算成功率</span></div></div>
    <p>待結算 ${u.pending} · 救援退卡 ${u.rescued} · 待領取 ${u.claimable} · 交付待核對 ${u.unverifiedDelivery}</p>
    <div class="values"><span>消耗卡片參考價值 <b>${money(u.consumedRaw)}</b></span><span>獎品參考價值 <b>${money(u.awardedRaw)}</b></span></div>
    <p>升級卡後續實收 ${money(u.laterProceedsRaw)} USDC</p>
    <small>參與依申請時間；估值變化依結算時間。參考估值不加進現金總額。</small></section>` : '';
  const group = new Map();
  for (const flow of report.flows) {
    if (!group.has(flow.activity)) group.set(flow.activity, { in: 0n, out: 0n });
    group.get(flow.activity)[flow.direction] += BigInt(flow.raw);
  }
  const flowTable = group.size ? `<section class="panel glass"><h2>現金分類</h2><table><thead><tr><th>分類</th><th>收入</th><th>支出</th><th>淨收支</th></tr></thead><tbody>${[...group].map(([name, amounts]) => `<tr><td>${escape(SCOPES[name] || name)}</td><td>${money(amounts.in)}</td><td>${money(amounts.out)}</td><td>${money(amounts.in - amounts.out)}</td></tr>`).join('')}</tbody></table></section>` : '';
  const details = report.filter.detail === 'detail' && u.spins.length ? `<section class="panel glass"><h2>升級明細</h2>${u.spins.slice(-12).map(spin => `<div class="record"><b>#${escape(spin.request.spinId)}</b><span>${escape(spin.stakeLabel)} → ${escape(spin.targetLabel)}<br><small>申請時機率 ${(spin.request.chanceBps / 100).toFixed(2)}% · 參考值 ${spin.request.valueDecimals === 6 ? money(spin.request.stakeValueRaw) + ' → ' + money(spin.request.targetValueRaw) + ' USDC' : '精度待核對'}<br>${time(spin.request.timestamp)}（台灣時間）</small></span><em>${OUTCOME_LABELS[spin.status]} · ${DELIVERY_LABELS[spin.delivery]}</em></div>`).join('')}<small>完整交易與證據請見 CSV；圖片最多顯示最近 12 筆。</small></section>` : '';
  const poolBreakdown = report.filter.detail !== 'summary' && report.analysis.byPool.length ? `<section class="panel glass"><h2>活動池與卡池收支</h2><table><thead><tr><th>活動池／卡池</th><th>收入</th><th>支出</th><th>淨收支</th></tr></thead><tbody>${report.analysis.byPool.map(row => `<tr><td>${escape(row.name)}</td><td>${money(row.inRaw)}</td><td>${money(row.outRaw)}</td><td>${money(row.netRaw)}</td></tr>`).join('')}</tbody></table></section>` : '';
  const realized = report.filter.detail !== 'summary' && report.realized.length ? `<section class="panel glass"><h2>可追溯已實現收支差額</h2><p>已核實 ${report.realizedSummary.knownCount} 筆 · 取得支出未知 ${report.realizedSummary.unknownCostCount} 筆</p><table><thead><tr><th>結算</th><th>實收</th><th>取得支出</th><th>差額</th></tr></thead><tbody>${report.realized.slice(-12).map(row => `<tr><td>${SCOPES[row.activity] || row.activity}</td><td>${money(row.proceedsRaw)}</td><td>${money(row.costRaw)}</td><td>${money(row.pnlRaw)}</td></tr>`).join('')}</tbody></table><small>差額為實收減已核實取得支出，不加上參考估值；完整證據請見 CSV。</small></section>` : '';
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Top.Market V2 Report</title><style>
    @font-face{font-family:Report;src:url(data:font/ttf;base64,${font})}*{box-sizing:border-box}body{margin:0;background:#080e18;color:#eef5ff;font-family:Report,Arial,sans-serif}article{position:relative;width:1120px;padding:46px;overflow:hidden;background:radial-gradient(ellipse at 12% 0%,#16395e 0,transparent 55%),radial-gradient(ellipse at 100% 75%,#144440 0,transparent 42%),#080e18}article:before{content:"";position:absolute;inset:0;pointer-events:none;background:repeating-linear-gradient(120deg,transparent 0 86px,#8cbfff08 87px 88px)}article>*{position:relative}.brand{color:#95e7ce;letter-spacing:3px;font-size:16px}.tag{float:right;color:#b5cae1;border:1px solid #678ba955;padding:5px 14px;border-radius:24px}h1{font-size:34px;margin:22px 0 12px;overflow-wrap:anywhere}.wallet{font-family:monospace;color:#b5cae1;font-size:19px;overflow-wrap:anywhere}.subtitle{color:#aec1d7;font-size:17px;margin:14px 0 26px}.metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}.glass{background:#060a1099;backdrop-filter:blur(16px) saturate(115%);border:1px solid #9eddf75c;box-shadow:inset 0 2px 1px #e4f6ff30,inset 0 -2px 1px #7bc6df15,0 10px 28px #0003;border-radius:22px}.metric{padding:23px 20px;min-height:142px}.metric span{display:block;font-size:15px;color:#bbcadb}.metric strong{display:block;font-size:32px;margin:12px 0 4px;overflow-wrap:anywhere}.metric[data-key=cashNet] strong{color:#9fe7c9}.metric[data-key=upgradeValue] strong{color:#b9c6ff}small{font-size:13px;color:#9bacc2;line-height:1.6}.panel{padding:24px;margin-top:20px}h2{font-size:21px;margin:0 0 18px}.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:22px}.stats b{font-size:28px;display:block;color:#d3e9ff}.stats span{display:block;font-size:14px;color:#9eafc5;margin-top:6px}p{font-size:16px;line-height:1.65;color:#bdccde}.values{display:flex;justify-content:space-between;gap:16px;font-size:15px}.values b{color:#c7d5ff;margin-left:10px}table{width:100%;border-collapse:collapse;font-size:16px}th,td{text-align:right;padding:11px 0;border-bottom:1px solid #8cbfff20}th:first-child,td:first-child{text-align:left}.record{display:grid;grid-template-columns:55px 1fr auto;gap:12px;border-bottom:1px solid #8cbfff20;padding:13px 0;font-size:14px}.record em{font-style:normal;color:#9fe7c9}.notice{color:#edd59d;font-size:14px;line-height:1.7}.footer{margin-top:27px;color:#92a7c1;font-size:13px;line-height:1.8}a{color:inherit}@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
    </style></head><body><article id="wallet-v2-poster"><div class="brand">TOP.MARKET<span class="tag">WALLET ANALYSIS V2</span></div><h1>${escape(report.title)}</h1>
    <div class="wallet">${escape(report.wallet)}</div><div class="subtitle">${escape(report.range.label)} · ${report.filter.dimension === 'origin' ? '卡片來源歸屬' : '交易發生分類'}</div>
    <div class="metrics">${cards}</div>${upgrade}${flowTable}${poolBreakdown}${realized}${details}
    ${report.warnings.length ? `<div class="notice">${report.warnings.map(escape).join('<br>')}</div>` : ''}
    <div class="footer">資料時間 ${escape(displayTime(report.asOf))}<br>現金、可追溯取得支出與參考估值分開呈現；不含 Gas，不作稅務成本認定。<br>文字、PNG、CSV 共用同一份報表計算結果。</div></article></body></html>`;
}
let browserPromise;
export async function posterBrowser() {
  if (browserPromise && !(await browserPromise).isConnected()) browserPromise = undefined;
  browserPromise ||= chromium.launch(process.platform === 'win32' || process.platform === 'darwin'
    ? { channel: 'chrome', headless: true }
    : { executablePath: process.env.POSTER_CHROME_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
    .catch(error => { browserPromise = undefined; throw error; });
  return browserPromise;
}
export async function renderPng(report) {
  const browser = await posterBrowser();
  const context = await browser.newContext({ viewport: { width: 1120, height: 900 }, deviceScaleFactor: 1, offline: true, reducedMotion: 'reduce' });
  try {
    const page = await context.newPage();
    await page.setContent(await htmlReport(report), { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    const rendered = await page.locator('.metric').evaluateAll(nodes => nodes.map(node => ({ key: node.dataset.key, raw: node.dataset.raw })));
    if (JSON.stringify(rendered) !== JSON.stringify(report.metrics.map(metric => ({ key: metric.key, raw: metric.raw ?? 'unknown' })))) throw Error('PNG metric mismatch');
    return await page.locator('#wallet-v2-poster').screenshot({ type: 'png' });
  } finally { await context.close(); }
}
export async function closeV2Browser() { if (browserPromise) { const browser = await browserPromise; browserPromise = undefined; await browser.close(); } }
