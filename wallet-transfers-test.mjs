import assert from 'node:assert/strict';
import { SIG, USDC, word } from './worker/index.js';
import { incomingUsdcLogs } from './worker/history/wallet-transfers.js';

const wallet = '0x' + 'a'.repeat(40), sender = '0x' + 'b'.repeat(40);
const hash = '0x' + 'c'.repeat(64);
const transfer = (block, uniqueId) => ({ blockNum: '0x' + block.toString(16), hash,
  to: wallet, category: 'erc20', rawContract: { address: USDC }, uniqueId });
const log = (block, logIndex) => ({ blockNumber: '0x' + block.toString(16), transactionHash: hash,
  logIndex: '0x' + logIndex.toString(16), address: USDC, topics: [SIG.transfer, word(sender), word(wallet)], data: '0x01' });
const receipt = { transactionHash: hash, status: '0x1', blockNumber: '0x64', logs: [log(100, 2), log(100, 5)] };

let requests = 0, receipts = 0;
const reader = {
  async rpc(method, [params]) {
    assert.equal(method, 'alchemy_getAssetTransfers');
    assert.equal(params.toAddress, wallet);
    assert.deepEqual(params.contractAddresses, [USDC]);
    assert.equal(params.toBlock, '0x6e');
    requests++;
    return requests === 1 ? { transfers: [transfer(100, 'first')], pageKey: 'next' }
      : { transfers: [transfer(100, 'second')] };
  },
  async batch(calls) {
    receipts++;
    assert.deepEqual(calls, [['eth_getTransactionReceipt', [hash]]]);
    return [receipt];
  },
};
const found = await incomingUsdcLogs(reader, wallet, 90, 110);
assert.deepEqual(found.map(item => Number(item.logIndex)), [2, 5]);
assert.equal(requests, 2);
assert.equal(receipts, 1);

await assert.rejects(incomingUsdcLogs({ rpc: async () => ({ transfers: [transfer(100, 'first')] }),
  batch: async () => [{ ...receipt, logs: [log(100, 2), log(100, 5)] }] }, wallet, 90, 110), /does not match/);
await assert.rejects(incomingUsdcLogs({ rpc: async () => ({ transfers: [transfer(111, 'outside')] }),
  batch: async () => { throw Error('Should not fetch receipt'); } }, wallet, 90, 110), /Invalid indexed/);
let repeatedPages = 0;
await assert.rejects(incomingUsdcLogs({ rpc: async () => { repeatedPages++; return { transfers: [], pageKey: 'repeated' }; },
  batch: async () => { throw Error('Should not fetch receipt'); } }, wallet, 90, 110), /pagination limit/);
assert.equal(repeatedPages, 2);
console.log('Wallet transfer index and receipt reconciliation passed');
