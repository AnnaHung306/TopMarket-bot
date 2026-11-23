import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { FileLedgerStore } from '../wallet-v2/store.mjs';
import { buildReport } from '../wallet-v2/report.mjs';
import { money } from '../wallet-v2/model.mjs';
import { summarizeWalletEvents, displayWalletTotals } from '../worker/report/accounting.js';
const { values } = parseArgs({ options: { wallet: { type: 'string' }, prefix: { type: 'string' },
  'ledger-dir': { type: 'string', default: 'work/wallet-v2/ledger' } } });
if (!values.wallet || !values.prefix) throw Error('Required: --wallet 0x… --prefix work/wallet-v2/reports/report');
function parseCsv(input) {
  const rows = []; let row = [], field = '', quoted = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (c === '\ufeff' && i === 0) continue;
    if (c === '"') { if (quoted && input[i + 1] === '"') { field += '"'; i++; } else quoted = !quoted; }
    else if (c === ',' && !quoted) { row.push(field); field = ''; }
    else if ((c === '\r' || c === '\n') && !quoted) { if (c === '\r' && input[i + 1] === '\n') i++; row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const columns = rows.shift(); return rows.map(values => Object.fromEntries(columns.map((key, index) => [key, values[index]])));
}
const ledger = await new FileLedgerStore(values['ledger-dir']).load(values.wallet);
const saved = JSON.parse(await readFile(values.prefix + '.json', 'utf8'));
const report = buildReport(ledger, saved.filter);
assert.deepEqual(saved.metrics, report.metrics, 'exported metrics no longer match current stored ledger');
const [text, csv, html, png] = await Promise.all(['.txt', '.csv', '.html', '.png'].map(extension => readFile(values.prefix + extension)));
const rows = parseCsv(csv.toString());
for (const metric of report.metrics) {
  const row = rows.find(row => row.record_type === 'metric' && row.id === metric.key);
  assert.equal(row?.raw_usdc, metric.raw ?? '');
  assert.ok(text.toString().includes(`${metric.label}：${money(metric.raw)}`));
  assert.ok(html.toString().includes(`data-key="${metric.key}" data-raw="${metric.raw ?? 'unknown'}"`));
}
assert.ok(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
assert.equal(png.readUInt32BE(16), 1120);
const grouped = report.analysis.byPool.reduce((sum, group) => sum + BigInt(group.netRaw), 0n);
assert.equal(grouped.toString(), report.cash.netRaw, 'pool grouping must conserve selected cash');
let nativeNetRaw = null;
if (report.filter.scope === 'all' && !report.filter.poolId && report.filter.period === 'all' && !report.pending.length) {
  const native = displayWalletTotals(summarizeWalletEvents(ledger.events.filter(event => event.legacyId)), []);
  nativeNetRaw = native.net.toString();
  assert.equal(report.cash.netRaw, nativeNetRaw, 'confirmed public sample differs from Gavin accounting');
}
console.log(JSON.stringify({ wallet: report.wallet, scope: report.filter.scope, metrics: report.metrics.length,
  csvRows: rows.length, png: { width: png.readUInt32BE(16), height: png.readUInt32BE(20), bytes: png.length },
  cashNetRaw: report.cash.netRaw, nativeGavinNetRaw: nativeNetRaw, knownRealizedRaw: report.realizedSummary.knownPnlRaw,
  retainedExpenditureRaw: report.holdings.filter(lot => lot.costRaw !== null).reduce((sum, lot) => sum + BigInt(lot.costRaw), 0n).toString(),
  referenceChangeRaw: report.upgrade.referenceChangeRaw, note: 'PNG DOM metrics are checked before screenshot; visual inspection is separate' }, null, 2));
