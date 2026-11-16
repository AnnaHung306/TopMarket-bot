import { hex, SIG, USDC, word } from '../index.js';
import { compactLog } from './chain.js';

const PAGE_SIZE = 1_000;
const MAX_PAGES = 20;
const HASH = /^0x[0-9a-f]{64}$/i;

// Query the transfer index for one recipient, then verify every result against
// the finalized transaction receipt before accepting it as cash-flow evidence.
export async function incomingUsdcLogs(reader, wallet, from, to) {
  const indexed = new Map();
  const seenKeys = new Set();
  let pageKey;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await reader.rpc('alchemy_getAssetTransfers', [{ fromBlock: hex(from), toBlock: hex(to),
      toAddress: wallet, contractAddresses: [USDC], category: ['erc20'],
      order: 'asc', maxCount: hex(PAGE_SIZE), ...(pageKey ? { pageKey } : {}) }]);
    if (!Array.isArray(result?.transfers) || result.transfers.length > PAGE_SIZE) throw Error('Incomplete wallet transfer index');
    for (const transfer of result.transfers) {
      const block = Number(transfer.blockNum);
      const hash = transfer.hash?.toLowerCase();
      if (transfer.category !== 'erc20' || transfer.to?.toLowerCase() !== wallet ||
        transfer.rawContract?.address?.toLowerCase() !== USDC || !HASH.test(hash || '') ||
        !Number.isSafeInteger(block) || block < from || block > to) throw Error('Invalid indexed USDC transfer');
      const entry = indexed.get(hash) ?? { block, count: 0 };
      if (entry.block !== block) throw Error('Conflicting indexed USDC transfer blocks');
      entry.count++;
      indexed.set(hash, entry);
    }
    if (!result.pageKey) break;
    if (page === MAX_PAGES - 1 || seenKeys.has(result.pageKey)) throw Error('Wallet transfer index pagination limit reached');
    seenKeys.add(result.pageKey);
    pageKey = result.pageKey;
  }
  const hashes = [...indexed.keys()];
  const receipts = await reader.batch(hashes.map(hash => ['eth_getTransactionReceipt', [hash]]));
  const output = [];
  for (let i = 0; i < hashes.length; i++) {
    const hash = hashes[i], receipt = receipts[i], entry = indexed.get(hash);
    if (receipt?.transactionHash?.toLowerCase() !== hash || receipt.status !== '0x1' ||
      Number(receipt.blockNumber) !== entry.block || !Array.isArray(receipt.logs)) throw Error('Indexed USDC transfer has no finalized receipt');
    const logs = receipt.logs.filter(log => log.address?.toLowerCase() === USDC &&
      log.topics?.length === 3 && log.topics[0]?.toLowerCase() === SIG.transfer &&
      log.topics[2]?.toLowerCase() === word(wallet));
    if (logs.length !== entry.count || logs.some(log => log.removed || !Number.isSafeInteger(Number(log.logIndex)))) {
      throw Error('USDC transfer index does not match transaction receipt');
    }
    output.push(...logs.map(compactLog));
  }
  return output.sort((a, b) => Number(a.blockNumber) - Number(b.blockNumber) || Number(a.logIndex) - Number(b.logIndex));
}
