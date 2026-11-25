import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { money } from './model.mjs';
import { posterHtml } from './poster-template.mjs';
import { visibleMetrics } from './report-text.mjs';

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
    'collection', 'token_id', 'card_name', 'custody', 'ownership_status', 'ownership_checked_through',
    'choice_deadline', 'choice_transaction', 'recycle_amount_raw', 'recycle_transfer_id', 'settlement_token', 'card_reference_raw'];
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
    acquisition_expenditure_raw: lot.costRaw, card_reference_raw: lot.referenceRaw,
    origin_pool_id: lot.originPoolId, evidence: lot.evidence.join(';') });
  for (const spin of report.upgrade.spins) rows.push({ record_type: 'upgrade', id: spin.id, activity: 'upgrade',
    pool_id: spin.poolId, time_taipei: time(spin.request.timestamp), stake_collection: spin.request.stakeCollection,
    stake_token_id: spin.request.stakeTokenId, stake_reference_raw: spin.request.stakeValueRaw,
    target_collection: spin.request.targetCollection, target_token_id: spin.request.targetTokenId,
    target_reference_raw: spin.request.targetValueRaw, reference_decimals: spin.request.valueDecimals,
    chance_bps: spin.request.chanceBps, edge_bps: spin.request.edgeBps, outcome: spin.status, delivery: spin.delivery,
    transaction: spin.request.tx, settlement_transaction: spin.result?.tx, stake_card_name: spin.stakeLabel, target_card_name: spin.targetLabel,
    choice_deadline: spin.choice?.deadline, choice_transaction: spin.resolution?.tx,
    recycle_amount_raw: spin.resolution?.category === 'WinRecycled' ? spin.resolution.recycleRaw : null,
    recycle_transfer_id: spin.resolution?.recycleTransferId, settlement_token: spin.resolution?.settlementToken,
    evidence: [spin.stakeTransferId, spin.deliveryTransferId].filter(Boolean).join(';'), note: '參考估值不是現金收入；參與按申請時間，收益按結算時間' });
  for (const row of report.pending) rows.push({ record_type: 'unresolved', id: row.id, activity: row.activity,
    time_taipei: time(row.timestamp), category: row.category, transaction: row.tx, verification: 'unresolved', note: row.reason });
  for (const source of report.coverage) rows.push({ record_type: 'coverage', id: source.key,
    verification: `${source.status};complete=${Boolean(source.complete)}`, note: source.reason || '' });
  for (const row of rows) if (/^0x[\da-f]{64}$/i.test(row.transaction || '')) row.transaction_url = `https://basescan.org/tx/${row.transaction}`;
  return '\ufeff' + [columns, ...rows.map(row => columns.map(column => row[column]))].map(row => row.map(csvCell).join(',')).join('\r\n');
}

export async function htmlReport(report) {
  const [font, logo] = await Promise.all([
    readFile(new URL('../assets/NotoSansTC.ttf', import.meta.url)),
    readFile(new URL('../assets/top-market-logo.svg', import.meta.url)),
  ]);
  return posterHtml(report, { font: font.toString('base64'), logo: logo.toString('base64') });
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
    if (JSON.stringify(rendered) !== JSON.stringify(visibleMetrics(report).map(metric => ({ key: metric.key, raw: metric.raw ?? 'unknown' })))) throw Error('PNG metric mismatch');
    return await page.locator('#wallet-v2-poster').screenshot({ type: 'png' });
  } finally { await context.close(); }
}
export async function closeV2Browser() { if (browserPromise) { const browser = await browserPromise; browserPromise = undefined; await browser.close(); } }
