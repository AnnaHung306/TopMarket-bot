import assert from 'node:assert/strict';
import { SIG, word } from './worker/index.js';
import { walletStateHistory } from './worker/history/wallet-state.js';

const box = '0x' + 'a'.repeat(40);
const oldPayer = '0x' + '1'.repeat(40), middlePayer = '0x' + '2'.repeat(40), newPayer = '0x' + '3'.repeat(40);
const update = (block, payer) => ({ address: box, blockNumber: '0x' + block.toString(16),
  transactionHash: '0x' + block.toString(16).padStart(64, '0'), logIndex: '0x0',
  topics: [SIG.treasuryUpdated, word(payer)], data: '0x' });
const events = [update(105, middlePayer), update(115, newPayer)];
const ranges = [];
const reader = {
  async rpc(method, [filter]) {
    assert.equal(method, 'eth_getLogs');
    const from = Number(filter.fromBlock), to = Number(filter.toBlock);
    ranges.push([from, to]);
    return filter.address.includes(box) ? events.filter(event => Number(event.blockNumber) >= from && Number(event.blockNumber) <= to) : [];
  },
  async batch(calls) {
    return calls.map(([method, params]) => {
      if (method === 'eth_getStorageAt') return '0x' + '0'.repeat(64);
      assert.equal(method, 'eth_call');
      const [target, at] = params;
      if (target.data === '0x5c60da1b') return '0x' + '0'.repeat(64);
      assert.equal(target.data, '0x61d027b3');
      return word(Number(at) < 105 ? oldPayer : Number(at) < 115 ? middlePayer : newPayer);
    });
  },
};
const first = await walletStateHistory(reader, [box], 100, 110);
ranges.length = 0;
const extended = await walletStateHistory(reader, [box], 100, 120, first);
assert.deepEqual(ranges, [[111, 120], [111, 120]]);
ranges.length = 0;
const full = await walletStateHistory(reader, [box], 100, 120);
assert.deepEqual(extended.updates, full.updates);
assert.deepEqual(extended.upgrades, full.upgrades);
for (const [block, payer, expected] of [[100, oldPayer, true], [105, oldPayer, false],
  [106, middlePayer, true], [115, middlePayer, false], [116, newPayer, true]]) {
  assert.equal(extended.isTreasury(payer, block), full.isTreasury(payer, block));
  assert.equal(extended.isTreasury(payer, block), expected);
}
await assert.rejects(walletStateHistory(reader, [box], 100, 110, first), /Invalid cached/);
console.log('Incremental wallet configuration matches full history');
