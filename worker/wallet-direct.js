import { boxes, hex, MARKET, SIG, STAKE, USDC, word } from './index.js';
import { activeAuction, alchemy, callRecord, compactLog, evidencePlan, getFilteredLogs, receiptRecord } from './history/chain.js';
import { readHistoricalCalls } from './history/multicall.js';
import { settleRecordedWallet } from './history/report.js';

export const WALLET_HISTORY_START = 50634768;
const WALLET_PAGE_LOGS = 400;
const TRANSFER_PAGE = '0x190';
let registry;

async function transferPage(reader, wallet, from, to, direction, category, pageKey) {
  const result = await reader.rpc('alchemy_getAssetTransfers', [{
    fromBlock: hex(from), toBlock: hex(to),
    [direction]: wallet,
    category: [category], ...(category === 'erc20' ? { contractAddresses: [USDC] } : {}),
    maxCount: TRANSFER_PAGE, order: 'asc', excludeZeroValue: true, ...(pageKey ? { pageKey } : {}),
  }]);
  if (!Array.isArray(result?.transfers)) throw Error('Alchemy returned incomplete wallet transfer data');
  return result;
}

function transferBoundary(page, from, to) {
  return page.pageKey ? Math.max(from, Number(page.transfers.at(-1)?.blockNum) - 1) : to;
}

async function transfersThrough(reader, firstPage, wallet, from, to, direction, category) {
  const transfers = firstPage.transfers.filter(item => Number(item.blockNum) <= to);
  if (!firstPage.pageKey || Number(firstPage.transfers.at(-1)?.blockNum) > to) return transfers;
  let pageKey;
  const block = to;
  const complete = transfers.filter(item => Number(item.blockNum) < block);
  do {
    const page = await transferPage(reader, wallet, block, block, direction, category, pageKey);
    complete.push(...page.transfers);
    pageKey = page.pageKey;
  } while (pageKey);
  return complete;
}

function selectPage(logs, from, to) {
  if (logs.length <= WALLET_PAGE_LOGS) return to;
  const boundary = logs.map(log => Number(log.blockNumber)).sort((a, b) => a - b)[WALLET_PAGE_LOGS];
  return Math.max(from, boundary);
}

async function contractsAt(reader, block) {
  if (registry?.block === block) return registry.contracts;
  const contracts = await boxes(block, reader.batch);
  registry = { block, contracts };
  return contracts;
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

export async function directWalletReport(wallet, from, to, reader = alchemy({ maxUnits: 120_000, maxMs: 240_000 }), contracts) {
  const started = performance.now();
  const [registered, incoming, outgoingCards] = await Promise.all([
    contracts ?? contractsAt(reader, hex(to)),
    transferPage(reader, wallet, from, to, 'toAddress', 'erc20'),
    transferPage(reader, wallet, from, to, 'fromAddress', 'erc721'),
  ]);
  const addresses = registered.map(item => item.address), knownBoxes = new Set(addresses);
  const recipient = word(wallet);
  let through = Math.min(transferBoundary(incoming, from, to), transferBoundary(outgoingCards, from, to));
  if (!Number.isSafeInteger(through)) throw Error('Invalid wallet transfer pagination');
  const getLogs = (address, topics) => Array.isArray(address) && address.length === 0
    ? Promise.resolve([])
    : getFilteredLogs(reader, { address, topics }, from, through);
  const direct = (await Promise.all([
    getLogs(addresses, [[SIG.draw, SIG.refund, SIG.rescue, SIG.kept, SIG.buyback, SIG.tokenBuyback], null, recipient]),
    getLogs(addresses, [[SIG.won, SIG.tokenDraw], null, null, recipient]),
    getLogs(STAKE, [[SIG.staked, SIG.unstaked], null, null, recipient]),
    getLogs(MARKET, [[SIG.sold, SIG.offer], null, null, recipient]),
    getLogs(MARKET, [SIG.auction, null, recipient]),
  ])).flat();
  through = selectPage(direct, from, through);
  const [received, soldCards, updates] = await Promise.all([
    transfersThrough(reader, incoming, wallet, from, through, 'toAddress', 'erc20'),
    transfersThrough(reader, outgoingCards, wallet, from, through, 'fromAddress', 'erc721'),
    getLogs(addresses, [[SIG.treasuryUpdated, SIG.feeRecipientUpdated]]),
  ]);
  const logs = new Map(direct.filter(log => Number(log.blockNumber) <= through)
    .filter(log => log.topics[0] !== SIG.auction || activeAuction(log))
    .map(log => [log.transactionHash + ':' + log.logIndex, log]));
  const candidates = new Set([...received, ...soldCards].map(item => item.hash));
  for (const hash of evidencePlan([...logs.values()]).receipts) candidates.add(hash);
  const hashes = [...candidates];
  const rawReceipts = await reader.batch(hashes.map(hash => ['eth_getTransactionReceipt', [hash]]));
  const receipts = new Map(hashes.map((hash, index) => [hash, receiptRecord(hash, rawReceipts[index])]));
  for (const receipt of rawReceipts) {
    for (const raw of receipt.logs) {
      const address = raw.address.toLowerCase(), signature = raw.topics[0];
      if (knownBoxes.has(address) && signature === SIG.buyback ||
          address === MARKET && ([SIG.sold, SIG.offer].includes(signature) || activeAuction(raw))) {
        const log = compactLog(raw);
        logs.set(log.transactionHash + ':' + log.logIndex, log);
      }
    }
  }
  const related = [...logs.values()];
  const plan = evidencePlan(related);
  const responses = await readHistoricalCalls(reader, plan.calls);
  const calls = plan.calls.map((call, index) => callRecord(call, responses[index]));
  const report = await settleRecordedWallet(wallet, related, [...receipts.values()], calls, updates);
  return { from, to: through, ...report, seconds: (performance.now() - started) / 1_000 };
}
