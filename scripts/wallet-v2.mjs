import { parseArgs } from 'node:util';
import { loadEnvFile } from 'node:process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { FileLedgerStore, PostgresLedgerStore } from '../wallet-v2/store.mjs';
import { createReader } from '../wallet-v2/reader.mjs';
import { createWalletV2Service } from '../wallet-v2/service.mjs';
import { buildReport, textReport } from '../wallet-v2/report.mjs';
import { csvReport, htmlReport, renderPng, closeV2Browser } from '../wallet-v2/exports.mjs';
import { address } from '../wallet-v2/model.mjs';

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  wallet: { type: 'string' }, scope: { type: 'string', default: 'all' }, pool: { type: 'string' },
  period: { type: 'string', default: 'all' }, from: { type: 'string' }, to: { type: 'string' },
  dimension: { type: 'string', default: 'location' }, detail: { type: 'boolean', default: false },
  view: { type: 'string' },
  'local-dir': { type: 'string', default: 'work/wallet-v2/ledger' }, output: { type: 'string' },
  storage: { type: 'string', default: 'file' }, 'rpc-url': { type: 'string' }, help: { type: 'boolean' },
  'rpc-concurrency': { type: 'string', default: '12' }, 'rpc-batch-size': { type: 'string', default: '25' },
  'rpc-min-interval': { type: 'string', default: '0' },
} });
if (values.help || !values.wallet) {
  console.log('V2 local entry (does not log in to Discord or use the existing DB):\n' +
    'node scripts/wallet-v2.mjs query --wallet 0x… [--scope upgrade|all|packs|raffle|market|buyback|staking|campaign]\n' +
    'node scripts/wallet-v2.mjs export --wallet 0x… [--pool pool-id] [--period custom --from YYYY-MM-DD --to YYYY-MM-DD]\n' +
    '--rpc-url explicitly selects a provider; without it ALCHEMY_API_KEY is required.\n' +
    '--local-dir chooses the separate persistent ledger. --output chooses the report file prefix.');
  process.exit(values.help ? 0 : 1);
}
let store;
try {
  const command = positionals[0] || 'query';
  if (!['query', 'export'].includes(command)) throw Error('Expected query or export');
  if (command === 'query' || values.storage === 'postgres') {
    try { loadEnvFile(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (!['file', 'postgres'].includes(values.storage)) throw Error('Unknown storage type');
  store = values.storage === 'postgres' ? new PostgresLedgerStore(process.env.WALLET_V2_DATABASE_URL) : new FileLedgerStore(values['local-dir']);
  if (store instanceof PostgresLedgerStore) await store.initialize();
  const wallet = address(values.wallet);
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  const service = createWalletV2Service({ store, readerFactory: () => createReader({ rpcUrl: values['rpc-url'], signal: controller.signal,
    concurrency: Number(values['rpc-concurrency']), batchSize: Number(values['rpc-batch-size']), minIntervalMs: Number(values['rpc-min-interval']) }) });
  const selection = { scope: values.scope, poolId: values.pool || null, period: values.period,
    from: values.from, to: values.to, dimension: values.dimension, detail: values.view || (values.detail ? 'detail' : 'summary') };
  let ledger, usage = null;
  if (command === 'query') ({ ledger, usage } = await service.query(wallet, { scope: values.scope,
    onProgress: progress => console.log('wallet_v2_progress', JSON.stringify(progress)) }));
  else ledger = await service.load(wallet);
  if (!ledger.asOf) throw Error('此錢包尚無 V2 明細；請先使用 query');
  const filterStart = performance.now();
  const report = buildReport(ledger, selection);
  const filterMs = Math.round((performance.now() - filterStart) * 100) / 100;
  const prefix = resolve(values.output || `work/wallet-v2/reports/${wallet}-${values.scope}`);
  await mkdir(dirname(prefix), { recursive: true });
  const pngStart = performance.now();
  const png = await renderPng(report);
  const posterMs = Math.round(performance.now() - pngStart);
  await Promise.all([
    writeFile(prefix + '.txt', textReport(report)), writeFile(prefix + '.csv', csvReport(report)),
    writeFile(prefix + '.json', JSON.stringify({ ...report, usage, filterMs, posterMs }, null, 2)),
    writeFile(prefix + '.html', await htmlReport(report)), writeFile(prefix + '.png', png),
  ]);
  console.log(textReport(report));
  console.log('wallet_v2_export', JSON.stringify({ prefix, filterMs, posterMs, filterOnly: command === 'export', pngBytes: png.length }));
} catch (error) {
  const secrets = ['ALCHEMY_API_KEY', 'DATABASE_URL', 'WALLET_V2_DATABASE_URL', 'DISCORD_TOKEN'].map(key => process.env[key]).filter(Boolean);
  let message = String(error.message);
  for (const secret of secrets) message = message.replaceAll(secret, '[redacted]');
  console.error(message.replace(/(?:https?|postgres(?:ql)?):\/\/\S+/gi, '[redacted-url]'));
  process.exitCode = 1;
} finally { await closeV2Browser(); await store?.close?.(); }
