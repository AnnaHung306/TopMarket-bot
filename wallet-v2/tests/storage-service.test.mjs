import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { FileLedgerStore } from '../store.mjs';
import { createWalletV2Service } from '../service.mjs';
import { WALLET_HISTORY_START } from '../gavin.mjs';
import { buildReport } from '../report.mjs';
import { verifyUpgradeVersion, upgradeDefinition } from '../registry.mjs';
import { testDirectory } from './helpers/directory.mjs';

const directory = testDirectory('file-store');
const newWallet = () => '0x' + randomBytes(20).toString('hex');
const hash = block => '0x' + Number(block).toString(16).padStart(64, '0');
function reader({ head = WALLET_HISTORY_START + 10, changedBlock } = {}) {
  return { stats: { units: 0, requests: 0, retries: 0, splits: 0 },
    rpc: async (method, params) => {
      if (method === 'eth_chainId') return '0x2105';
      if (method === 'eth_getBlockByNumber') {
        const block = params[0] === 'finalized' ? head : Number(params[0]);
        return { number: '0x' + block.toString(16), hash: block === changedBlock ? hash(block + 9999) : hash(block), timestamp: '0x6b03eba3' };
      }
      throw Error('Unexpected test RPC: ' + method);
    },
    batch: async calls => calls.map(([method, params]) => {
      if (method !== 'eth_getBlockByNumber') return null;
      const block = params[0] === 'finalized' ? head : Number(params[0]);
      return { number: '0x' + block.toString(16), hash: hash(block), timestamp: '0x6b03eba3' };
    }),
  };
}
const catalogLoader = async () => ({ pools: [], cards: {}, unsupported: [] });
const quiet = { info() {}, error() {} };
test('file ledger persists across store instances; stale revision cannot overwrite successful progress', async () => {
  const wallet = newWallet(), store = new FileLedgerStore(directory);
  const empty = await store.load(wallet);
  const first = await store.save(wallet, 0, { ...empty, asOf: '2026-11-23T00:00:00Z', events: [{ id: 'public-evidence', block: 1, timestamp: 1 }] });
  const reread = await new FileLedgerStore(directory).load(wallet);
  assert.deepEqual(reread, first);
  await assert.rejects(store.save(wallet, 0, { ...empty, events: [] }), /revision conflict/);
  assert.deepEqual(await store.load(wallet), first);
});
test('persistent report view checks revision and prevents unsafe filenames', async () => {
  const store = new FileLedgerStore(directory), id = randomBytes(16).toString('hex');
  const saved = await store.saveView({ id, ownerId: 'owner-a', wallet: newWallet(), selection: { scope: 'upgrade' } });
  assert.equal((await new FileLedgerStore(directory).loadView(id)).ownerId, 'owner-a');
  await assert.rejects(store.saveView({ ...saved, ownerId: 'owner-b' }, 0), /revision conflict/);
  await assert.rejects(store.loadView('../outside'), /Invalid/);
});
test('concurrent same-wallet queries share one scan; filter changes use only persisted details', async () => {
  const wallet = newWallet(), store = new FileLedgerStore(directory);
  let scans = 0, factories = 0;
  const service = createWalletV2Service({ store, readerFactory: () => { factories++; return reader(); },
    catalogLoader, logger: quiet, gavinScanner: async (_reader, _wallet, from, to) => {
      scans++; await new Promise(resolve => setTimeout(resolve, 5)); return { from, to, events: [], warnings: [] };
    } });
  const [first, second] = await Promise.all([service.query(wallet, { scope: 'packs' }), service.query(wallet, { scope: 'market' })]);
  assert.equal(scans, 1); assert.equal(factories, 1); assert.deepEqual(first.ledger, second.ledger);
  const ledger = await service.load(wallet);
  for (const scope of ['all', 'packs', 'market', 'raffle', 'staking', 'campaign']) buildReport(ledger, { scope });
  assert.equal(factories, 1, 'filter-only operations do not request a reader');
  await service.query(wallet, { scope: 'packs' });
  assert.equal(scans, 1, 'no new finalized blocks means no rescan');
});
test('a failed page leaves the last atomic checkpoint resumable without losing events', async () => {
  const wallet = newWallet(), store = new FileLedgerStore(directory); let calls = 0;
  const firstService = createWalletV2Service({ store, readerFactory: () => reader(), catalogLoader, logger: quiet,
    gavinScanner: async (_reader, _wallet, from) => {
      calls++; if (calls === 2) throw Error('simulated upstream outage');
      return { from, to: from + 1, events: [], warnings: [] };
    } });
  await assert.rejects(firstService.query(wallet, { scope: 'packs' }), /upstream outage/);
  const partial = await store.load(wallet);
  assert.equal(partial.coverage.gavin.through, WALLET_HISTORY_START + 1);
  assert.equal(partial.coverage.gavin.complete, false);
  let resumedFrom;
  const secondService = createWalletV2Service({ store, readerFactory: () => reader(), catalogLoader, logger: quiet,
    gavinScanner: async (_reader, _wallet, from, to) => { resumedFrom = from; return { from, to, events: [], warnings: [] }; } });
  const result = await secondService.query(wallet, { scope: 'packs' });
  assert.equal(resumedFrom, WALLET_HISTORY_START + 2);
  assert.equal(result.ledger.coverage.gavin.complete, true);
});
test('changed finalized block hash is rejected before another checkpoint is committed', async () => {
  const wallet = newWallet(), store = new FileLedgerStore(directory);
  const service = createWalletV2Service({ store, readerFactory: () => reader(), catalogLoader, logger: quiet,
    gavinScanner: async (_reader, _wallet, from, to) => ({ from, to, events: [], warnings: [] }) });
  await service.query(wallet, { scope: 'packs' });
  const before = await store.load(wallet);
  const broken = createWalletV2Service({ store, readerFactory: () => reader({ head: WALLET_HISTORY_START + 20, changedBlock: before.coverage.gavin.through }),
    catalogLoader, logger: quiet, gavinScanner: async () => { throw Error('must not scan'); } });
  await assert.rejects(broken.query(wallet, { scope: 'packs', force: true }), /no longer matches/);
  assert.deepEqual(await store.load(wallet), before);
});
test('missing receipt is a hard evidence failure, not an empty successful wallet', async () => {
  const wallet = newWallet(), store = new FileLedgerStore(directory), tx = '0x' + 'a'.repeat(64);
  const service = createWalletV2Service({ store, readerFactory: () => reader(), catalogLoader, logger: quiet,
    gavinScanner: async (_reader, _wallet, from, to) => ({ from, to, events: [{ id: tx + ':0x1', tx,
      block: from, logIndex: 1, category: 'purchaseGross', currency: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      contract: '0x' + 'b'.repeat(40), raw: '1000000' }] }) });
  await assert.rejects(service.query(wallet, { scope: 'packs' }), /交易回執/);
  assert.equal((await store.load(wallet)).revision, 0);
});
test('unknown historical proxy implementation is rejected even if current address is unchanged', async () => {
  const definition = await upgradeDefinition();
  const pool = { ...definition, definition };
  const changingReader = { stats: { splits: 0 }, rpc: async method => method === 'eth_getStorageAt'
    ? '0x' + '0'.repeat(24) + '1'.repeat(40) : [] };
  await assert.rejects(verifyUpgradeVersion(changingReader, pool, pool.startBlock, pool.startBlock + 10), /尚未核實/);
});
test('a late concurrent request for an additional scope obtains the missing source after an earlier scan finishes', async () => {
  const wallet = newWallet(), store = new FileLedgerStore(directory);
  const save = store.save.bind(store); let release, entered, firstSave = true, scans = 0;
  const ready = new Promise(resolve => { entered = resolve; });
  store.save = async (...args) => {
    if (firstSave) { firstSave = false; entered(); await new Promise(resolve => { release = resolve; }); }
    return save(...args);
  };
  const service = createWalletV2Service({ store, readerFactory: () => reader(), catalogLoader, logger: quiet,
    gavinScanner: async (_reader, _wallet, from, to) => { scans++; return { from, to, events: [], warnings: [] }; } });
  const first = service.query(wallet, { scope: 'upgrade' }); await ready;
  const late = service.query(wallet, { scope: 'all' }); release();
  await first;
  const result = await late;
  assert.equal(scans, 1); assert.equal(result.ledger.coverage.gavin.complete, true);
  assert.ok(result.usage.queryId);
});
test('Gavin verified receipt-free treasury events do not trigger V2 receipt fetching', async () => {
  const wallet = newWallet(), store = new FileLedgerStore(directory), baseReader = reader(); let receiptCalls = 0;
  const batch = baseReader.batch;
  baseReader.batch = calls => { receiptCalls += calls.filter(([method]) => method === 'eth_getTransactionReceipt').length; return batch(calls); };
  const tx = '0x' + 'e'.repeat(64);
  const service = createWalletV2Service({ store, readerFactory: () => baseReader, catalogLoader, logger: quiet,
    gavinScanner: async (_reader, _wallet, from, to) => ({ from, to, events: [{ id: tx + ':0x1', tx, block: from, logIndex: 1,
      category: 'staking-treasury', contract: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', raw: '1000000' }], warnings: [] }) });
  const { ledger } = await service.query(wallet, { scope: 'staking' });
  assert.equal(receiptCalls, 0);
  assert.equal(buildReport(ledger, { scope: 'staking' }).cash.inRaw, '1000000');
});
