import { getFilteredLogs } from '../worker/history/chain.js';
import { address, asAddress, eventId, hex, word, TRANSFER, ordered, SCHEMA_VERSION, SCOPES } from './model.mjs';
import { randomUUID } from 'node:crypto';
import { createReader } from './reader.mjs';
import { loadCatalog } from './registry.mjs';
import { normalizeGavin, scanGavin, WALLET_HISTORY_START } from './gavin.mjs';
import { scanUpgrades, receiptTransfers } from './upgrade.mjs';
import { verifyAdapterAcquisitions } from './acquisition-evidence.mjs';
import { updateCardLabels } from './card-labels.mjs';
import { compactReceipt, observeEvidence, pruneTransfers, receiptContext } from './evidence.mjs';
import { querySources, localDay, freshForDay, recordSourceChecks } from './freshness.mjs';
import { cardValuesFresh, updateCardValues } from './card-values.mjs';

const unique = rows => [...new Map(rows.map(row => [row.id, row])).values()];
const alignedSnapshot = (ledger, sources) => !sources.has('upgrade') || ledger.catalog.filter(pool => pool.kind === 'upgrade')
  .every(pool => ledger.coverage[pool.id]?.status === 'unsupported' || ledger.coverage[pool.id]?.through === ledger.coverage.gavin?.through);

export function createWalletV2Service({ store, readerFactory = () => createReader(), catalogLoader = loadCatalog,
  gavinScanner = scanGavin, upgradeScanner = scanUpgrades, logger = console, now = Date.now } = {}) {
  if (!store) throw Error('V2 persistent store is required');
  const active = new Map();
  async function run(wallet, flight, { scope, onProgress } = {}) {
    const began = performance.now();
    let ledger = await store.load(wallet);
    if (ledger.version !== SCHEMA_VERSION) throw Error('Unsupported V2 schema');
    const historyFresh = !flight.force && freshForDay(ledger, [...flight.sources], localDay(now())) && alignedSnapshot(ledger, flight.sources);
    if (historyFresh && cardValuesFresh(ledger)) {
      const usage = { units: 0, requests: 0, retries: 0, splits: 0, methods: {}, provider: 'database',
        queryId: flight.id, pages: 0, queryMs: Math.round(performance.now() - began), estimated: true, cacheHit: true };
      logger.info('wallet_v2_query', JSON.stringify({ wallet, scope, ...usage }));
      return { ledger, usage };
    }
    ledger.receipts ||= {}; ledger.blocks ||= {}; ledger.ownershipCoverage ||= {};
    const reader = observeEvidence(readerFactory(), () => ledger);
    flight.reader = reader;
    const chain = await reader.rpc('eth_chainId', []);
    if (Number(chain) !== 8453) throw Error('V2 只接受 Base Mainnet，RPC 鏈別不符');
    if (historyFresh && !flight.force) {
      const saved = ledger.coverage.gavin;
      const block = await reader.rpc('eth_getBlockByNumber', [hex(saved.through), false]);
      if (block?.hash !== saved.blockHash) throw Error('Saved V2 checkpoint no longer matches Base history');
      await updateCardValues(reader, ledger);
      ledger = await store.save(wallet, ledger.revision, ledger);
      const usage = { ...reader.stats, queryId: flight.id, pages: 0, queryMs: Math.round(performance.now() - began),
        estimated: true, cacheHit: false, valuationOnly: true };
      logger.info('wallet_v2_query', JSON.stringify({ wallet, scope, ...usage }));
      return { ledger, usage };
    }
    const head = await reader.rpc('eth_getBlockByNumber', ['finalized', false]);
    const checkedAt = new Date(now()).toISOString();
    if (!head?.hash || !Number.isSafeInteger(Number(head.number))) throw Error('Cannot verify finalized Base head');
    const through = Number(head.number);
    ledger.blocks[through] = { hash: head.hash, timestamp: Number(head.timestamp) };
    const catalog = await catalogLoader(reader, through);
    // Retain names of closed pools that disappeared from the public listing.
    ledger.catalog = [...new Map([...(ledger.catalog || []), ...catalog.pools].map(pool => [pool.id, pool])).values()];
    ledger.cards = { ...ledger.cards, ...catalog.cards };
    ledger.unsupported = catalog.unsupported;
    const initialReceiptContext = receiptContext(ledger, true);
    ledger.receipts = Object.fromEntries(Object.entries(ledger.receipts).map(([tx, receipt]) => [tx, compactReceipt(receipt, ledger, { context: initialReceiptContext })]));
    pruneTransfers(ledger);
    let pages = 0;

    async function hydrate(events) {
      // Gavin already verifies synthetic/cash-log evidence. Only new upgrade raw logs and
      // nominal marketplace purchases require additional receipt retrieval in V2.
      const txs = [...new Set(events.filter(event => event.rawLog || event.category === 'purchaseGross' && event.currency === '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913')
        .map(event => event.tx))].filter(tx => !ledger.receipts[tx]);
      const receipts = await reader.batch(txs.map(tx => ['eth_getTransactionReceipt', [tx]]));
      receipts.forEach(receipt => { if (!receipt || receipt.status !== '0x1') throw Error('缺少成功交易回執，未提交新進度'); });
      for (const event of events.filter(event => event.rawLog)) {
        const proof = ledger.receipts[event.tx]?.logs.find(log => Number(log.logIndex) === event.logIndex && log.address.toLowerCase() === event.contract);
        if (!proof || proof.data !== event.rawLog.data || JSON.stringify(proof.topics) !== JSON.stringify(event.rawLog.topics)) throw Error('鏈上事件與交易回執不相符，未提交新進度');
      }
      ledger.transfers = unique([...ledger.transfers, ...reader.transferEvidence(events),
        ...Object.values(ledger.receipts).flatMap(receipt => receiptTransfers(receipt, wallet))]);
      ledger.events = unique([...ledger.events, ...events]).sort(ordered);
      pruneTransfers(ledger);
      const context = receiptContext(ledger, true);
      ledger.receipts = Object.fromEntries(Object.entries(ledger.receipts).map(([tx, receipt]) => [tx, compactReceipt(receipt, ledger, { context })]));
      const blocks = [...new Set([...events, ...ledger.transfers].map(event => event.block))].filter(block => !ledger.blocks[block]);
      const found = await reader.batch(blocks.map(block => ['eth_getBlockByNumber', [hex(block), false]]));
      found.forEach((block, i) => { if (!block?.hash || Number(block.number) !== blocks[i]) throw Error('Missing historical block timestamp');
        ledger.blocks[blocks[i]] = { hash: block.hash, timestamp: Number(block.timestamp) }; });
      for (const event of [...events, ...ledger.transfers]) event.timestamp = ledger.blocks[event.block].timestamp;
    }
    async function commit(key, last, start, complete = last === through) {
      const block = ledger.blocks[last] || await reader.rpc('eth_getBlockByNumber', [hex(last), false]);
      ledger.coverage[key] = { start, through: last, target: through, blockHash: block.hash, complete,
        asOf: new Date(Number(head.timestamp) * 1000).toISOString(), status: 'verified' };
      ledger.asOf = new Date(Number(head.timestamp) * 1000).toISOString();
      ledger = await store.save(wallet, ledger.revision, ledger);
      await onProgress?.({ source: key, through: last, target: through, pages, estimatedCu: reader.stats.units });
    }
    async function nextFrom(key, start) {
      const saved = ledger.coverage[key];
      if (!saved || saved.status !== 'verified') return start;
      if (saved.through > through) throw Error('Finalized head moved behind the saved V2 checkpoint');
      const block = ledger.blocks[saved.through] || await reader.rpc('eth_getBlockByNumber', [hex(saved.through), false]);
      // Re-read the chain hash, rather than trusting the persisted hash itself.
      const chainBlock = saved.through === through ? head : await reader.rpc('eth_getBlockByNumber', [hex(saved.through), false]);
      if (chainBlock?.hash !== saved.blockHash || block.hash !== saved.blockHash) throw Error('Saved V2 checkpoint no longer matches Base history');
      return saved.through + 1;
    }
    const processed = new Set();
    while ([...flight.sources].some(source => !processed.has(source))) {
      for (const source of [...flight.sources].filter(source => !processed.has(source))) {
        if (source === 'gavin') {
          let from = await nextFrom('gavin', WALLET_HISTORY_START);
          while (from <= through) {
            const page = await gavinScanner(reader, wallet, from, through);
            if (page.to < from || page.to > through) throw Error('V2 scan checkpoint did not advance');
            await hydrate(normalizeGavin(page.events));
            ledger.warnings = [...new Set([...ledger.warnings, ...(page.warnings || [])])];
            pages++;
            await commit('gavin', page.to, WALLET_HISTORY_START);
            from = page.to + 1;
          }
        } else {
          for (const pool of ledger.catalog.filter(pool => pool.kind === 'upgrade')) {
            if (pool.supported === false) { ledger.coverage[pool.id] = { status: 'unsupported', reason: pool.unsupportedReason }; continue; }
            const from = await nextFrom(pool.id, pool.startBlock);
            if (from <= through) {
              try {
                const page = await upgradeScanner(reader, wallet, pool, from, through, ledger.events);
                await hydrate(page.events); pages++;
                await commit(pool.id, page.to, pool.startBlock);
              } catch (error) {
                if (!/尚未核實/.test(error.message)) throw error;
                ledger.coverage[pool.id] = { status: 'unsupported', reason: error.message };
              }
            }
          }
        }
        processed.add(source);
      }
    }
    await verifyAdapterAcquisitions(reader, ledger,
      progress => onProgress?.({ source: 'acquisition-proof', ...progress, estimatedCu: reader.stats.units }),
      async () => { const saved = await store.save(wallet, ledger.revision, ledger); ledger.revision = saved.revision; });
    // Ownership continuity is scanned only for actual NFT collections in this wallet's evidence.
    // Continuity can establish acquisition expenditure only after Gavin's acquisition history exists.
    // Both all/upgrade queries include Gavin, so upgrade proceeds and basis can
    // be checked at the same finalized head as the upgrade outcomes.
    const collections = ledger.coverage.gavin?.complete
      ? [...new Set([...ledger.transfers.filter(t => t.kind === 'nft' && t.walletRelated).map(t => t.collection),
        ...ledger.events.filter(e => ['kept', 'purchaseGross', 'staked', 'unstaked'].includes(e.category) && e.collection).map(e => e.collection),
        ...ledger.events.filter(e => e.category === 'UpgradeRequested').flatMap(e => [e.stakeCollection, e.targetCollection])])] : [];
    for (const collection of collections) {
      const from = (ledger.ownershipCoverage[collection] ?? WALLET_HISTORY_START - 1) + 1;
      if (from > through) continue;
      const logs = (await Promise.all([
        getFilteredLogs(reader, { address: collection, topics: [TRANSFER, word(wallet)] }, from, through),
        getFilteredLogs(reader, { address: collection, topics: [TRANSFER, null, word(wallet)] }, from, through),
      ])).flat().filter(log => log.topics.length === 4);
      ledger.transfers = unique([...ledger.transfers, ...logs.map(log => ({
        id: eventId(log.transactionHash, log.logIndex), tx: log.transactionHash.toLowerCase(), block: Number(log.blockNumber),
        logIndex: Number(log.logIndex), collection: address(log.address), tokenId: BigInt(log.topics[3]).toString(),
        from: asAddress(log.topics[1]), to: asAddress(log.topics[2]), kind: 'nft', walletRelated: true,
      }))]);
      ledger.ownershipCoverage[collection] = through;
    }
    await hydrate([]);
    await updateCardLabels(ledger);
    await updateCardValues(reader, ledger);
    recordSourceChecks(ledger, processed, through, checkedAt);
    ledger = await store.save(wallet, ledger.revision, ledger);
    const usage = { ...reader.stats, queryId: flight.id, pages, queryMs: Math.round(performance.now() - began), estimated: true, cacheHit: false };
    logger.info('wallet_v2_query', JSON.stringify({ wallet, scope, ...usage }));
    return { ledger, usage };
  }
  const api = {
    async query(walletValue, options = {}) {
      if (!SCOPES[options.scope || 'all']) throw Error('無效報表範圍');
      const wallet = address(walletValue), sources = querySources(options.scope || 'all'), day = localDay(now());
      const existing = active.get(wallet);
      if (existing) {
        sources.forEach(source => existing.sources.add(source));
        if (options.force) existing.force = true;
        const result = await existing.promise;
        const missing = !freshForDay(result.ledger, sources, day) || !alignedSnapshot(result.ledger, new Set(sources)) ||
          options.force && (result.usage.cacheHit || result.usage.valuationOnly);
        return missing ? api.query(wallet, options) : result;
      }
      const flight = { id: randomUUID(), sources: new Set(sources), force: Boolean(options.force), began: performance.now() };
      flight.promise = run(wallet, flight, options).catch(error => {
        logger.error('wallet_v2_query_failed', JSON.stringify({ wallet, scope: options.scope || 'all',
          ...flight.reader?.stats, queryId: flight.id, queryMs: Math.round(performance.now() - flight.began), estimated: true }));
        throw error;
      }).finally(() => active.delete(wallet));
      active.set(wallet, flight); return flight.promise;
    },
    load: wallet => store.load(address(wallet)),
  };
  return api;
}
