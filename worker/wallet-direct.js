import { addr, boxes, decode, decodeReward, hex, MARKET, SIG, STAKE, USDC, word } from './index.js';
import { activeAuction, alchemy, callKey, callRecord, evidencePlan, getFilteredLogs } from './history/chain.js';
import { settleRecordedWallet } from './history/report.js';
import { campaignPayoutEvents } from './history/campaign-payouts.js';
import { RAFFLE_CONTRACT, RAFFLE_SHARES_BOUGHT, raffleEvents, readRaffleLogs } from './history/raffle.js';
import { treasuryStaking } from './history/treasury-staking.js';
import { readWalletDeferredPayments, readWalletDrawSources, walletEvidence } from './history/wallet-evidence.js';
import { readWalletHistoricalCalls, walletStateHistory } from './history/wallet-state.js';

export const WALLET_HISTORY_START = 50634768;
const WALLET_PAGE_LOGS = 2_000;
const WALLET_PAGE_INCOMING = 800;
export const WALLET_PARALLEL_PAGES = 6;
const TRANSFER_PAGE = '0x3e8';
const DISCOVERY_CACHE_TTL = 120_000;
const DISCOVERY_CACHE_ENTRIES = 4;
const DISCOVERY_CACHE_LOGS = 40_000;
const discoveryCache = new Map();
let registry, configSnapshot;

async function outgoingPage(reader, wallet, from, to, pageKey) {
  const result = await reader.rpc('alchemy_getAssetTransfers', [{
    fromBlock: hex(from), toBlock: hex(to), fromAddress: wallet, category: ['erc721'],
    maxCount: TRANSFER_PAGE, order: 'asc', excludeZeroValue: true, ...(pageKey ? { pageKey } : {}),
  }]);
  if (!Array.isArray(result?.transfers)) throw Error('Alchemy returned incomplete wallet transfer data');
  return result;
}

function transferBoundary(page, from, to) {
  return page.pageKey ? Math.max(from, Number(page.transfers.at(-1)?.blockNum) - 1) : to;
}

async function outgoingThrough(reader, firstPage, wallet, to) {
  const transfers = firstPage.transfers.filter(item => Number(item.blockNum) <= to);
  if (!firstPage.pageKey || Number(firstPage.transfers.at(-1)?.blockNum) > to) return transfers;
  let pageKey;
  const block = to;
  const complete = transfers.filter(item => Number(item.blockNum) < block);
  do {
    const page = await outgoingPage(reader, wallet, block, block, pageKey);
    complete.push(...page.transfers);
    pageKey = page.pageKey;
  } while (pageKey);
  return complete;
}

function selectPage(logs, from, to, limit = WALLET_PAGE_LOGS) {
  if (logs.length <= limit) return to;
  const boundary = logs.map(log => Number(log.blockNumber)).sort((a, b) => a - b)[limit];
  return Math.max(from, boundary);
}

function isRelevantIncoming(log, history, from, through) {
  const block = Number(log.blockNumber);
  const payer = addr(log.topics[1]);
  return block >= from && block <= through && (history.isTreasury(payer, block) || payer === MARKET);
}

function canReuseDiscovery(discovery, from) {
  const { activity, expires, limited } = discovery;
  if (expires <= performance.now() || from < discovery.from || from > activity.through) return false;
  if (!limited) return true;
  // A partial cache is sufficient only if a complete block within it sets the next page boundary.
  return activity.direct.filter(log => Number(log.blockNumber) >= from).length > WALLET_PAGE_LOGS ||
    discovery.incoming.filter(log => isRelevantIncoming(log, activity.history, from, activity.through)).length > WALLET_PAGE_INCOMING;
}

function limitDiscoveryCache(discovery) {
  const { activity, incoming, outgoing, raffles } = discovery;
  const groups = [activity.direct, incoming, outgoing, raffles];
  if (groups.reduce((count, logs) => count + logs.length, 0) <= DISCOVERY_CACHE_LOGS) return discovery;
  const blocks = groups.flatMap(logs => logs.map(log => Number(log.blockNumber))).sort((a, b) => a - b);
  const through = blocks[DISCOVERY_CACHE_LOGS] - 1;
  const within = log => Number(log.blockNumber) <= through;
  return { ...discovery, limited: true, activity: { ...activity, through, direct: activity.direct.filter(within) },
    incoming: incoming.filter(within), outgoing: outgoing.filter(within), raffles: raffles.filter(within) };
}

async function contractsAt(reader, block) {
  if (registry?.block === block) return registry.contracts;
  const contracts = await boxes(block, reader.batch);
  registry = { block, contracts };
  return contracts;
}

async function configuration(reader, addresses, to) {
  const key = hex(to) + ':' + addresses.join(',');
  if (configSnapshot?.key !== key) {
    const history = await walletStateHistory(reader, addresses, WALLET_HISTORY_START, to);
    if (addresses.length && !history.payers.size) throw Error('Top.Market treasury could not be identified at the wallet snapshot');
    configSnapshot = { key, history };
  }
  return configSnapshot.history;
}

function logsWithPossibleProof(logs, receipts, wallet) {
  const cashIn = new Map(), cashOut = new Set(), cardsIn = new Set();
  for (const { tx, receipt } of receipts) {
    for (const log of receipt.logs) {
      if (log.topics[0] !== SIG.transfer) continue;
      if (log.address === USDC && log.topics.length === 3) {
        if (addr(log.topics[1]) === wallet) cashOut.add(tx);
        if (addr(log.topics[2]) === wallet) {
          if (!cashIn.has(tx)) cashIn.set(tx, new Set());
          cashIn.get(tx).add(BigInt(log.data).toString());
        }
      } else if (log.topics.length === 4 && addr(log.topics[2]) === wallet) cardsIn.add(tx);
    }
  }
  return logs.filter(log => {
    const sig = log.topics[0], tx = log.transactionHash;
    if (sig === SIG.draw || sig === SIG.tokenDraw) return cashOut.has(tx);
    if (sig === SIG.kept) return log.dispositionCandidate || cardsIn.has(tx);
    if (sig === SIG.buyback || sig === SIG.tokenBuyback) return decodeReward(log, wallet).some(event => cashIn.get(tx)?.has(event.raw));
    if (sig === SIG.refund || sig === SIG.rescue) return cashIn.get(tx)?.has(decode(log).raw);
    return true;
  });
}

export async function finalizedWalletBlock(reader) {
  const block = await reader.rpc('eth_getBlockByNumber', ['finalized', false]);
  if (!block?.hash || Number(block.number) < WALLET_HISTORY_START) throw Error('Cannot verify Base finalized head');
  return block;
}

export async function directWalletHead(reader = alchemy({ maxUnits: 3_000 })) {
  const block = await finalizedWalletBlock(reader);
  const contracts = await contractsAt(reader, block.number);
  return { start: WALLET_HISTORY_START, head: Number(block.number), asOf: new Date(Number(block.timestamp) * 1_000).toISOString(),
    contracts, chainId: 8453, rpc: 'Alchemy Base Mainnet', directWallet: true, usage: reader.stats };
}

function outgoingPaymentLogs(reader, recipient, boxLogs, raffleLogs) {
  let first = Infinity, last = -Infinity, hasDraws = false;
  const addBlock = log => {
    const block = Number(log.blockNumber);
    first = Math.min(first, block);
    last = Math.max(last, block);
  };
  for (const logs of boxLogs) {
    for (const log of logs) {
      if (log.topics[0] !== SIG.draw && log.topics[0] !== SIG.tokenDraw) continue;
      hasDraws = true;
      addBlock(log);
    }
  }
  for (const log of raffleLogs) {
    if (log.topics[0] === RAFFLE_SHARES_BOUGHT) addBlock(log);
  }
  if (first === Infinity) return [];
  // Draw verification compares every USDC destination in the matched transaction.
  const topics = hasDraws ? [SIG.transfer, recipient] : [SIG.transfer, recipient, word(RAFFLE_CONTRACT)];
  return getFilteredLogs(reader, { address: USDC, topics }, first, last);
}

async function discoverWallet(reader, wallet, from, to, contracts, key) {
  const cached = discoveryCache.get(key);
  if (cached && canReuseDiscovery(cached, from)) {
    return { shared: Promise.resolve(cached), outgoing: Promise.resolve(cached.outgoing) };
  }
  const recipient = word(wallet);
  const [registered, outgoingCards] = await Promise.all([
    contracts ?? contractsAt(reader, hex(to)),
    outgoingPage(reader, wallet, from, to),
  ]);
  const addresses = registered.map(item => item.address);
  const through = transferBoundary(outgoingCards, from, to);
  if (!Number.isSafeInteger(through)) throw Error('Invalid wallet transfer pagination');
  const getLogs = (address, topics) => Array.isArray(address) && address.length === 0
    ? Promise.resolve([])
    : getFilteredLogs(reader, { address, topics }, from, through);
  const boxLogs = Promise.all([
    getLogs(addresses, [[SIG.draw, SIG.refund, SIG.rescue, SIG.kept, SIG.buyback, SIG.tokenBuyback], null, recipient]),
    getLogs(addresses, [[SIG.won, SIG.tokenDraw], null, null, recipient]),
  ]);
  const raffleLogs = readRaffleLogs(reader, wallet, from, through);
  const outgoing = Promise.all([boxLogs, raffleLogs])
    .then(([boxes, raffles]) => outgoingPaymentLogs(reader, recipient, boxes, raffles));
  const shared = Promise.all([
    configuration(reader, addresses, to),
    getLogs(USDC, [SIG.transfer, null, recipient]),
    raffleLogs,
    boxLogs,
    getLogs(STAKE, [[SIG.staked, SIG.unstaked], null, null, recipient]),
    getLogs(MARKET, [[SIG.sold, SIG.offer], null, null, recipient]),
    getLogs(MARKET, [SIG.auction, null, recipient]),
  ]).then(([history, incoming, raffles, boxEvents, ...marketAndStake]) => {
    const cardAddresses = new Set(registered.filter(contract => contract.type === 'card').map(contract => contract.address));
    const direct = [...boxEvents, ...marketAndStake].flat();
    const activity = { addresses, cardAddresses, history, outgoingCards, through, direct };
    return { from, activity, incoming, raffles, expires: performance.now() + DISCOVERY_CACHE_TTL };
  });
  return { shared, outgoing };
}

function walletPage(discovery, from) {
  const { activity, incoming } = discovery;
  const direct = activity.direct.filter(log => Number(log.blockNumber) >= from);
  const { history, through } = activity;
  const relevant = incoming.filter(log => isRelevantIncoming(log, history, from, through));
  const end = Math.min(selectPage(direct, from, through), selectPage(relevant, from, through, WALLET_PAGE_INCOMING));
  return { from, through: end, direct, discovery };
}

function rememberDiscovery(key, discovery, cacheable, through) {
  if (cacheable && cacheable.activity.through > through) {
    discoveryCache.delete(key);
    if (discoveryCache.size >= DISCOVERY_CACHE_ENTRIES) discoveryCache.delete(discoveryCache.keys().next().value);
    discoveryCache.set(key, cacheable);
  } else if (discoveryCache.get(key) === discovery) {
    discoveryCache.delete(key);
  }
}

async function settlementEvidence(reader, wallet, logs, payments, soldCards, activity, from, through) {
  const { addresses, cardAddresses, history } = activity;
  const proof = await walletEvidence(reader, wallet, logs, payments, soldCards, addresses, cardAddresses, history, from, through);
  const related = [...logs.values()];
  const plan = evidencePlan(related, true);
  const required = evidencePlan(logsWithPossibleProof(related, proof.receipts, wallet), true).calls;
  const responses = await readWalletHistoricalCalls(reader, required, history);
  const historical = new Map(required.map((call, index) => [callKey(call[1]), responses[index]]));
  const calls = plan.calls.map(call => callRecord(call, historical.get(callKey(call[1])) ?? null));
  return { ...proof, related, calls };
}

async function settleWalletPage(reader, wallet, { from, through, direct, discovery }, outgoing, deferred) {
  const { activity, incoming, raffles } = discovery;
  const { history, outgoingCards } = activity;
  const inPage = log => {
    const block = Number(log.blockNumber);
    return block >= from && block <= through;
  };
  const updates = history.updates.filter(inPage);
  const logs = new Map(direct.filter(log => Number(log.blockNumber) <= through)
    .filter(log => log.topics[0] !== SIG.auction || activeAuction(log))
    .map(log => [log.transactionHash + ':' + log.logIndex, log]));
  const [sources, settlement] = await Promise.allSettled([
    readWalletDrawSources(reader, logs, from, through),
    outgoingThrough(reader, outgoingCards, wallet, through)
      .then(cards => {
        const soldCards = cards.filter(item => Number(item.blockNum) >= from);
        const payments = {
          incoming: incoming.filter(inPage),
          outgoing: outgoing.then(logs => logs.filter(inPage)),
          deferred: deferred.then(logs => logs.filter(inPage)),
        };
        return settlementEvidence(reader, wallet, logs, payments, soldCards, activity, from, through);
      }),
  ]);
  if (sources.status === 'rejected') throw sources.reason;
  if (settlement.status === 'rejected') throw settlement.reason;
  const { receipts, deferred: deferredLogs, syntheticReceipts, related, calls, cash } = settlement.value;
  for (const log of sources.value) syntheticReceipts.get(log.transactionHash)?.logs.push(log);
  const { events, warnings } = await settleRecordedWallet(wallet, related, receipts, calls, updates, true);
  const used = new Set(events.map(event => event.id));
  const raffleLogs = raffles.filter(inPage);
  for (const event of [...raffleEvents(wallet, raffleLogs, cash), ...campaignPayoutEvents(wallet, cash)]) {
    if (used.has(event.id)) continue;
    events.push(event);
    used.add(event.id);
  }
  events.push(...treasuryStaking(wallet, cash, events, deferredLogs, history.isTreasury));
  return { from, to: through, events, warnings };
}

async function directWalletReports(wallet, from, to, reader, contracts, maxPages) {
  const started = performance.now();
  const key = JSON.stringify([wallet, to, contracts]);
  const { shared, outgoing } = await discoverWallet(reader, wallet, from, to, contracts, key);
  const settledPages = shared.then(async discovery => {
    const pages = [walletPage(discovery, from)];
    // The cache limit applies when retaining discovery for another request.
    while (pages.length < maxPages) {
      const next = pages.at(-1).through + 1;
      if (!canReuseDiscovery(discovery, next)) break;
      pages.push(walletPage(discovery, next));
    }
    const deferred = Promise.resolve(readWalletDeferredPayments(reader, wallet, discovery.activity.addresses, from, pages.at(-1).through));
    const [paymentState, ...results] = await Promise.allSettled([
      deferred,
      ...pages.map(page => settleWalletPage(reader, wallet, page, outgoing, deferred)),
    ]);
    if (paymentState.status === 'rejected') throw paymentState.reason;
    return { discovery, results };
  });
  const [settled, payments] = await Promise.allSettled([settledPages, outgoing]);
  if (settled.status === 'rejected') throw settled.reason;
  if (payments.status === 'rejected') throw payments.reason;
  const { discovery, results } = settled.value;
  const failure = results.findIndex(result => result.status === 'rejected');
  if (failure === 0) throw results[0].reason;
  // Only a consecutive prefix can move the checkpoint past a failed page.
  const complete = results.slice(0, failure === -1 ? results.length : failure).map(result => result.value);
  const through = complete.at(-1).to;
  const reusable = limitDiscoveryCache({ ...discovery, outgoing: payments.value });
  rememberDiscovery(key, discovery, reusable, through);
  return {
    from, to: through,
    events: complete.flatMap(page => page.events),
    warnings: complete.flatMap(page => page.warnings),
    seconds: (performance.now() - started) / 1_000,
  };
}

export function directWalletReport(wallet, from, to, reader = alchemy({ maxUnits: 120_000, maxMs: 240_000 }), contracts) {
  return directWalletReports(wallet, from, to, reader, contracts, 1);
}

export function directWalletReportBatch(wallet, from, to, reader, contracts) {
  return directWalletReports(wallet, from, to, reader, contracts, WALLET_PARALLEL_PAGES);
}
