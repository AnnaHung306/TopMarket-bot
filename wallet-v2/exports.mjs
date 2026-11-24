import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { money, displayTime } from './model.mjs';
import { METRIC_EMOJI, amount, upgradeProfit, holdingCost, showHoldings } from './report-text.mjs';

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
    'settlement_transaction', 'stake_card_name', 'target_card_name', 'transaction_url', 'evidence', 'verification', 'note',
    'collection', 'token_id', 'card_name', 'custody', 'ownership_status', 'ownership_checked_through'];
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
  for (const lot of report.holdings) rows.push({ record_type: 'holding', id: `${lot.collection}:${lot.tokenId}`,
    collection: lot.collection, token_id: lot.tokenId, card_name: lot.cardLabel, custody: lot.custody ? 'staking' : 'wallet',
    ownership_status: lot.ownershipStatus, ownership_checked_through: lot.ownershipCheckedThrough,
    acquisition_expenditure_raw: lot.costRaw, origin_pool_id: lot.originPoolId, evidence: lot.evidence.join(';') });
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
  const cards = report.metrics.map(metric => `<section class="metric glass" data-key="${metric.key}" data-raw="${metric.raw ?? 'unknown'}"><span>${METRIC_EMOJI[metric.key]} ${escape(metric.label)}</span><strong>${escape(money(metric.raw))}</strong><small>${metric.kind === 'reference' ? 'USDC 估值' : 'USDC'}</small></section>`).join('');
  const u = report.upgrade;
  const pending = [[u.pending, '待結算'], [u.rescued, '已救援'], [u.claimable, '待領取'], [u.unverifiedDelivery, '交付待核對']]
    .filter(([count]) => count).map(([count, label]) => `${label} ${count}`).join(' · ');
  const upgrade = ['all', 'upgrade'].includes(report.filter.scope) && (report.filter.scope === 'upgrade' || u.requests || u.won || u.lost || pending)
    ? `<section class="upgrade glass"><h2>⬆️ 卡牌升級</h2><div class="stats"><span>🎮 參與 <b>${u.requests}</b></span><span>✅ 成功 <b>${u.won}</b></span><span>❌ 失敗 <b>${u.lost}</b></span></div><div class="upgrade-income"><span>📥 升級卡後續收入<strong>${escape(amount(u.laterProceedsRaw))}</strong></span><span>🏆 升級後已實現收益<strong>${escape(upgradeProfit(u))}</strong>${u.unknownCostCount ? `<small>${u.unknownCostCount} 筆成本待確認</small>` : ''}</span></div>${pending ? `<p class="notice">⏳ ${pending}</p>` : ''}</section>` : '';
  const h = report.holdingsSummary;
  const holdings = showHoldings(report) ? `<section class="holdings glass"><h2>🃏 目前卡牌持倉</h2><div class="stats holding-stats"><span>👛 錢包 <b>${h.walletCount}</b></span><span>🔒 質押 <b>${h.stakedCount}</b></span></div>${h.walletCount + h.stakedCount ? `<p>💳 持倉成本 <b>${escape(holdingCost(h))}</b>${h.unknownCostCount ? ` · ${h.unknownCostCount} 張成本待確認` : ''}</p>` : ''}${h.unverifiedCount ? `<p class="notice">🔎 ${h.unverifiedCount} 張持有狀態待確認</p>` : ''}</section>` : '';
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Top.Market V2 Report</title><style>
    @font-face{font-family:Report;src:url(data:font/ttf;base64,${font})}*{box-sizing:border-box}body{margin:0;background:#080e18;color:#eef5ff;font-family:Report,"Noto Color Emoji","Segoe UI Emoji",Arial,sans-serif}article{position:relative;width:1120px;padding:44px;overflow:hidden;background:radial-gradient(ellipse at 12% 0%,#16395e 0,transparent 55%),radial-gradient(ellipse at 100% 85%,#144440 0,transparent 48%),#080e18}article:before{content:"";position:absolute;inset:0;pointer-events:none;background:repeating-linear-gradient(120deg,transparent 0 86px,#8cbfff08 87px 88px)}article>*{position:relative}.brand{color:#95e7ce;letter-spacing:3px;font-size:26px}h1{font-size:40px;line-height:1.25;margin:20px 0 12px;overflow-wrap:anywhere}.wallet{font-family:monospace;color:#b5cae1;font-size:24px;overflow-wrap:anywhere}.subtitle{color:#aec1d7;font-size:26px;margin:12px 0 24px}.metrics{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.glass{background:#060a1099;backdrop-filter:blur(16px) saturate(115%);border:1px solid #9eddf75c;box-shadow:inset 0 2px 1px #e4f6ff30,inset 0 -2px 1px #7bc6df15,0 10px 28px #0003;border-radius:24px}.metric{padding:20px 26px}.metric span{display:block;font-size:26px;color:#bbcadb}.metric strong{display:block;font-size:60px;line-height:1.15;margin:10px 0 6px;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}.metric[data-key=cashNet]{grid-column:1/-1;order:-1;padding:22px 30px}.metric[data-key=cashNet] strong{font-size:96px;color:${BigInt(report.cash.netRaw) < 0n ? '#ff9da5' : '#9fe7c9'}}.metric[data-key=upgradeValue] strong{color:#b9c6ff}.metric[data-key=realized]:last-child{grid-column:1/-1}small{font-size:24px;color:#9bacc2;line-height:1.35}.upgrade,.holdings{padding:20px 26px;margin-top:16px;display:grid;grid-template-columns:280px 1fr;align-items:center;gap:10px}h2{font-size:28px;margin:0}.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;font-size:26px;color:#bbcadb}.stats b{font-size:40px;color:#d3e9ff;margin-left:10px}.upgrade p,.holdings p{grid-column:1/-1;margin:6px 0 0}.holdings p{font-size:26px;color:#bbcadb;margin:4px 0}.holding-stats{grid-template-columns:repeat(2,1fr)}.upgrade-income{grid-column:1/-1;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px;padding-top:10px;font-size:25px;color:#bbcadb}.upgrade-income strong{display:block;font-size:36px;color:#d3e9ff;margin-top:8px;overflow-wrap:anywhere}.notice{color:#edd59d;font-size:24px;line-height:1.5;margin-top:16px}.footer{margin-top:22px;color:#a2b5ca;font-size:24px;line-height:1.5}@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
    .metric:only-child,article[data-scope=upgrade] .metric{grid-column:1/-1}article[data-scope=upgrade] .metric[data-key=upgradeValue]{order:-1}article[data-scope=upgrade] .metric[data-key=upgradeValue] strong{font-size:96px}
    </style></head><body><article id="wallet-v2-poster" data-scope="${report.filter.scope}"><div class="brand">TOP.MARKET</div><h1>${escape(report.title)}</h1>
    <div class="wallet">${escape(report.wallet)}</div><div class="subtitle">${escape(report.range.label)}</div>
    <div class="metrics">${cards}</div>${holdings}${upgrade}
    ${!report.complete || report.pending.length || report.realizedSummary.unknownCostCount ? `<div class="notice">${[!report.complete ? '部分資料待核對' : '', report.pending.length ? report.pending.length + ' 筆金額待核對' : '', report.realizedSummary.unknownCostCount ? report.realizedSummary.unknownCostCount + ' 筆成本未知' : ''].filter(Boolean).join(' · ')}</div>` : ''}
    <div class="footer">資料截至：${escape(displayTime(report.asOf))}</div></article></body></html>`;
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
