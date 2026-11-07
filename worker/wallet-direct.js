import { addr, boxes, decode, decodeReward, hex, MARKET, SIG, STAKE, USDC, word } from './index.js';
import { activeAuction, alchemy, callKey, callRecord, evidencePlan, getFilteredLogs } from './history/chain.js';
import { settleRecordedWallet } from './history/report.js';
import { campaignPayoutEvents } from './history/campaign-payouts.js';
import { treasuryStaking } from './history/treasury-staking.js';
import { walletEvidence } from './history/wallet-evidence.js';
import { readWalletHistoricalCalls, walletStateHistory } from './history/wallet-state.js';

export const WALLET_HISTORY_START = 50634768;
const WALLET_PAGE_LOGS = 2_000;
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
    if (sig === SIG.draw) return cashOut.has(tx);
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

async function walletActivity(reader, wallet, from, to, contracts) {
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
  const [history, ...batches] = await Promise.all([
    configuration(reader, addresses, to),
    getLogs(addresses, [[SIG.draw, SIG.refund, SIG.rescue, SIG.kept, SIG.buyback, SIG.tokenBuyback], null, recipient]),
    getLogs(addresses, [[SIG.won, SIG.tokenDraw], null, null, recipient]),
    getLogs(STAKE, [[SIG.staked, SIG.unstaked], null, null, recipient]),
    getLogs(MARKET, [[SIG.sold, SIG.offer], null, null, recipient]),
    getLogs(MARKET, [SIG.auction, null, recipient]),
  ]);
  const cardAddresses = new Set(registered.filter(contract => contract.type === 'card').map(contract => contract.address));
  return { addresses, cardAddresses, history, outgoingCards, through, direct: batches.flat() };
}

async function discoverWallet(reader, wallet, from, to, contracts, key) {
  const cached = discoveryCache.get(key);
  if (cached?.expires > performance.now() && cached.from <= from && from <= cached.activity.through) {
    return cached;
  }
  const recipient = word(wallet);
  const cashLogs = topics => getFilteredLogs(reader, { address: USDC, topics }, from, to);
  const [activity, incoming, outgoing] = await Promise.all([
    walletActivity(reader, wallet, from, to, contracts),
    cashLogs([SIG.transfer, null, recipient]),
    cashLogs([SIG.transfer, recipient]),
  ]);
  return { from, activity, incoming, outgoing, expires: performance.now() + DISCOVERY_CACHE_TTL };
}

export async function directWalletReport(wallet, from, to, reader = alchemy({ maxUnits: 120_000, maxMs: 240_000 }), contracts) {
  const started = performance.now();
  const key = JSON.stringify([wallet, to, contracts]);
  const discovery = await discoverWallet(reader, wallet, from, to, contracts, key);
  const { activity, incoming, outgoing } = discovery;
  const { addresses, cardAddresses, history, outgoingCards } = activity;
  const direct = activity.direct.filter(log => Number(log.blockNumber) >= from);
  let { through } = activity;
  const relevantIncoming = incoming.filter(log => {
    const block = Number(log.blockNumber);
    const payer = addr(log.topics[1]);
    return block >= from && block <= through && (history.isTreasury(payer, block) || payer === MARKET);
  });
  through = Math.min(selectPage(direct, from, through), selectPage(relevantIncoming, from, through, 800));
  if (through < activity.through && activity.direct.length + incoming.length + outgoing.length <= DISCOVERY_CACHE_LOGS) {
    discoveryCache.delete(key);
    if (discoveryCache.size >= DISCOVERY_CACHE_ENTRIES) discoveryCache.delete(discoveryCache.keys().next().value);
    discoveryCache.set(key, discovery);
  } else if (discoveryCache.get(key) === discovery) {
    discoveryCache.delete(key);
  }
  const soldCards = (await outgoingThrough(reader, outgoingCards, wallet, through))
    .filter(item => Number(item.blockNum) >= from);
  const cash = [...incoming, ...outgoing].filter(log => {
    const block = Number(log.blockNumber);
    return block >= from && block <= through;
  });
  const updates = history.updates.filter(log => Number(log.blockNumber) >= from && Number(log.blockNumber) <= through);
  const logs = new Map(direct.filter(log => Number(log.blockNumber) <= through)
    .filter(log => log.topics[0] !== SIG.auction || activeAuction(log))
    .map(log => [log.transactionHash + ':' + log.logIndex, log]));
  const { receipts, deferred } = await walletEvidence(reader, wallet, logs, cash, soldCards, addresses, cardAddresses, history, from, through);
  const related = [...logs.values()];
  const plan = evidencePlan(related, true);
  const required = evidencePlan(logsWithPossibleProof(related, receipts, wallet), true).calls;
  const responses = await readWalletHistoricalCalls(reader, required, history);
  const historical = new Map(required.map((call, index) => [callKey(call[1]), responses[index]]));
  const calls = plan.calls.map(call => callRecord(call, historical.get(callKey(call[1])) ?? null));
  const { events, warnings } = await settleRecordedWallet(wallet, related, receipts, calls, updates, true);
  const used = new Set(events.map(event => event.id));
  events.push(...campaignPayoutEvents(wallet, cash).filter(event => !used.has(event.id)));
  events.push(...treasuryStaking(wallet, cash, events, deferred, history.isTreasury));
  return { from, to: through, events, warnings, seconds: (performance.now() - started) / 1_000 };
}
