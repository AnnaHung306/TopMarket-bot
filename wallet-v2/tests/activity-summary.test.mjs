import test from 'node:test';
import assert from 'node:assert/strict';
import { activitySummary } from '../activity-summary.mjs';
import { SCOPES } from '../model.mjs';

const verified = { status: 'verified', complete: true };
const coverage = { gavin: verified };
test('all activity rows remain present at zero, including one-sided income and expense categories', () => {
  const rows = activitySummary([], [], coverage, [verified]);
  assert.deepEqual(rows.map(row => row.id), Object.keys(SCOPES).filter(id => id !== 'all'));
  assert.ok(rows.every(row => row.inRaw === '0' && row.outRaw === '0' && row.netRaw === '0'));
});

test('activity cash is partitioned once; the standalone packs/buyback overlap is not reproduced', () => {
  const flows = [
    { activity: 'packs', direction: 'out', raw: '100000000' },
    { activity: 'buyback', direction: 'in', raw: '80000000' },
    { activity: 'raffle', direction: 'out', raw: '2000000' },
    { activity: 'staking', direction: 'in', raw: '3000000' },
    { activity: 'campaign', direction: 'in', raw: '4000000' },
    { activity: 'market', direction: 'out', raw: '5000000' },
    { activity: 'upgrade', direction: 'in', raw: '6000000' },
  ];
  const rows = activitySummary(flows, [], coverage, [verified]);
  assert.equal(rows.find(row => row.id === 'packs').inRaw, '0');
  assert.equal(rows.find(row => row.id === 'buyback').inRaw, '80000000');
  assert.equal(rows.reduce((value, row) => value + BigInt(row.inRaw), 0n), 93000000n);
  assert.equal(rows.reduce((value, row) => value + BigInt(row.outRaw), 0n), 107000000n);
  assert.equal(rows.reduce((value, row) => value + BigInt(row.netRaw), 0n), -14000000n);
});

test('incomplete history and pending payments remain unknown without hiding their category', () => {
  const missing = activitySummary([], [], {}, [{ status: 'unsupported' }]);
  assert.equal(missing.length, 7); assert.ok(missing.every(row => row.netRaw === null));
  const pending = activitySummary([], [{ activity: 'market' }], coverage, [verified]);
  assert.equal(pending.find(row => row.id === 'market').inRaw, null);
  assert.ok(pending.filter(row => row.id !== 'market').every(row => row.netRaw === '0'));
});
