import assert from 'node:assert/strict';
import { formatReport } from './discord-report.mjs';
import { createWalletQuery } from './discord-wallet-query.mjs';
import { summarizeWalletEvents } from './worker/report/accounting.js';
import { renderGavinPoster as renderPoster, closePosterBrowser } from './discord-gavin-poster.mjs';

const wallet = '0x' + 'a'.repeat(40);
const totals = summarizeWalletEvents([]);
totals.pack = '1234567'; totals.sales = '5000000'; totals.pendingPacks = '1';
const old = { start: 1, through: 10, asOf: '2026-01-01', totals };
const updated = { ...old, through: 20, asOf: new Date().toISOString() };
const newest = { ...updated, through: 22 };
const usage = { units: 60, requests: 1, retries: 0, splits: 0 };
const calls = [];
const pages = [
  { ready: true, cached: true, snapshot: old },
  { ready: false, page: {}, progress: { through: 15, target: 20, resumed: true }, usage },
  { ready: true, page: {}, progress: { resumed: true }, snapshot: updated, usage },
  { ready: true, page: {}, progress: { resumed: false }, snapshot: newest, usage },
];
const query = createWalletQuery(async (address, after) => {
  calls.push([address, after]);
  return pages.shift();
});
const result = await query(wallet);
assert.equal(result.snapshot, newest);
assert.equal(result.pages, 3);
assert.deepEqual(result.usage, { units: 180, requests: 3, retries: 0, splits: 0 });
assert.deepEqual(calls, [[wallet, undefined], [wallet, 10], [wallet, 10], [wallet, 20]]);

const report = formatReport(wallet, newest);
assert.match(report, /抽卡花費（已核實）：1\.234567 USDC/);
assert.match(report, /已識別淨收支：3\.765433 USDC/);
assert.match(report, /1 筆事件待核對/);
assert.match(report, /不含持倉估值/);
try {
  const image = await renderPoster(wallet, newest);
  assert.deepEqual([...image.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.ok(image.length > 10000);
} finally {
  await closePosterBrowser();
}
console.log('Discord query, report and PNG tests passed');