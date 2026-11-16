import assert from 'node:assert/strict';
import { SIG, USDC, word } from './worker/index.js';
import { incomingUsdcLogs, outgoingUsdcLogs } from './worker/history/wallet-transfers.js';

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

const outgoing = { ...transfer(100, 'outgoing'), from: wallet, to: sender };
const outgoingReceipt = { ...receipt, logs: [{ ...log(100, 2), topics: [SIG.transfer, word(wallet), word(sender)] }] };
let outgoingRequests = 0;
const outgoingReader = {
  async rpc(method, [params]) {
    assert.equal(method, 'alchemy_getAssetTransfers');
    assert.equal(params.fromAddress, wallet);
    outgoingRequests++;
    return { transfers: [outgoing] };
  },
  async batch(calls) { assert.deepEqual(calls, [['eth_getTransactionReceipt', [hash]]]); return [outgoingReceipt]; },
};
assert.equal((await outgoingUsdcLogs(outgoingReader, wallet, 90, 110)).length, 1);
assert.equal((await outgoingUsdcLogs(outgoingReader, wallet, 90, 110, sender)).length, 1);
assert.equal((await outgoingUsdcLogs(outgoingReader, wallet, 90, 110, '0x' + 'd'.repeat(40))).length, 0);
assert.equal(outgoingRequests, 3);
console.log('Wallet transfer index and receipt reconciliation passed');
