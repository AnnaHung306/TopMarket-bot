import test from 'node:test';
import assert from 'node:assert/strict';
import { compactReceipt, observeEvidence, pruneTransfers } from '../evidence.mjs';
import { USDC, TRANSFER, word } from '../model.mjs';
const wallet = '0x' + '1'.repeat(40), other = '0x' + '2'.repeat(40), tx = '0x' + '3'.repeat(64);
const transfer = (to, index) => ({ address: USDC, transactionHash: tx, blockNumber: '0x1', logIndex: '0x' + index.toString(16),
  topics: [TRANSFER, word(other), word(to)], data: '0x01' });
test('large batched payouts retain this wallet proof without persisting unrelated recipients', () => {
  const receipt = { transactionHash: tx, blockNumber: '0x1', status: '0x1', logs: [transfer(wallet, 0),
    ...Array.from({ length: 2000 }, (_, index) => transfer(other, index + 1))] };
  const compact = compactReceipt(receipt, { wallet, catalog: [], events: [] });
  assert.equal(compact.logs.length, 1);
  assert.equal(compact.logs[0].topics[2], word(wallet));
  assert.equal(compact.proofOnly, true);
  assert.ok(JSON.stringify(compact).length < JSON.stringify(receipt).length / 100);
});
test('Gavin receives the unchanged full response, never a stored proof-only receipt on a later call', async () => {
  const receipt = { transactionHash: tx, status: '0x1', logs: [transfer(wallet, 0), transfer(other, 1)] };
  const ledger = { wallet, catalog: [], events: [], receipts: {} }; let calls = 0;
  const reader = observeEvidence({ rpc: async () => { calls++; return receipt; }, batch: async () => [] }, () => ledger);
  assert.strictEqual(await reader.rpc('eth_getTransactionReceipt', [tx]), receipt);
  assert.equal(ledger.receipts[tx].logs.length, 1);
  assert.strictEqual(await reader.rpc('eth_getTransactionReceipt', [tx]), receipt);
  assert.equal(calls, 2);
  assert.equal(reader.transferEvidence([{ tx }]).length, 1);
});
test('transfer pruning preserves custody evidence for relevant NFT while dropping unrelated transfers', () => {
  const collection = '0x' + '4'.repeat(40);
  const ledger = { wallet, events: [{ collection, tokenId: '7' }], transfers: [
    { id: 'own-cash', kind: 'usdc', from: other, to: wallet, walletRelated: true },
    { id: 'other-cash', kind: 'usdc', from: other, to: other, walletRelated: false },
    { id: 'custody', kind: 'nft', collection, tokenId: '7', from: other, to: other, walletRelated: false },
    { id: 'other-nft', kind: 'nft', collection, tokenId: '8', from: other, to: other, walletRelated: false },
  ] };
  pruneTransfers(ledger);
  assert.deepEqual(ledger.transfers.map(transfer => transfer.id), ['own-cash', 'custody']);
});
