import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeWalletEvents, displayWalletTotals } from '../../worker/report/accounting.js';
import { siteSummary } from '../site-summary.mjs';

const verified = { status: 'verified', complete: true };
test('Gavin original accounting and the report rows agree, including refunds and NFT raffle prizes', () => {
  const events = ['pack', 'purchaseGross', 'buyback-claim-confirmed', 'campaign-payout', 'raffle-participation',
    'raffle-refund', 'raffle-income', 'staking-confirmed', 'kept-disposal-confirmed', 'sales', 'refund-confirmed', 'raffle-card']
    .map((category, i) => ({ id: String(i), category, raw: String((i + 1) * 1000000), paymentVerified: true,
      ...(category === 'campaign-payout' ? { compensationRaw: '1000000', prizeRaw: '2000000', otherRaw: '1000000' } : {}) }));
  const original = displayWalletTotals(summarizeWalletEvents(events), events);
  const rows = siteSummary(events.filter(e => e.category !== 'raffle-card'), [], events, verified, 'all', { upgradeIncomeKnown: true });
  const mapping = { pack: 'pack', marketPurchases: 'marketPurchases', buyback: 'buybackReceived', airdrop: null,
    raffleParticipation: null, raffleIncome: 'raffleIncome', staking: 'stakingInflow', sales: 'sales', refund: 'refund' };
  for (const [key, field] of Object.entries(mapping)) if (field) assert.equal(rows.find(row => row.key === key)[key === 'raffleIncome' ? 'cashRaw' : 'raw'], String(original[field]));
  assert.equal(rows.find(row => row.key === 'airdrop').raw, String(original.compensation + original.campaignPrizes + original.campaignOther));
  assert.equal(rows.find(row => row.key === 'raffleParticipation').raw, String(original.raffleParticipation - original.raffleRefund));
  assert.equal(rows.find(row => row.key === 'raffleIncome').cards, 1);
  assert.equal(rows.find(row => row.key === 'raffleIncome').raw, null, 'an unpriced NFT must not become zero income');
  assert.equal(rows.find(row => row.key === 'sales').label, '市場賣卡');
});

test('empty verified history retains every original field; unknown and pending receipts stay unknown', () => {
  const zero = siteSummary([], [], [], verified, 'all', { upgradeIncomeKnown: true });
  assert.equal(zero.length, 8); assert.ok(zero.every(row => row.raw === '0'));
  assert.ok(siteSummary([], [], [], {}).every(row => row.raw === null));
  const pending = siteSummary([], [{ category: 'buyback-claim-pending' }], [], verified, 'all', { upgradeIncomeKnown: true });
  assert.equal(pending.find(row => row.key === 'buyback').raw, null);
  assert.ok(pending.filter(row => row.key !== 'buyback').every(row => row.raw === '0'));
});

test('upgrade recycle cash joins buyback once, without changing staking', () => {
  const rows = siteSummary([{ category: 'buyback-claim-confirmed', raw: '200000000' },
    { category: 'WinRecycled', raw: '1044000000' }], [], [], verified, 'all', { upgradeIncomeKnown: true });
  assert.equal(rows.find(row => row.key === 'buyback').raw, '1244000000');
  assert.equal(rows.find(row => row.key === 'staking').raw, '0');
  assert.ok(rows.filter(row => row.key !== 'buyback').every(row => row.raw === '0'));
});

test('merged buyback remains unknown if upgrade history or a recycle payment is unverified', () => {
  const flows = [{ category: 'buyback-claim-confirmed', raw: '200000000' }];
  assert.equal(siteSummary(flows, [], [], verified).find(row => row.key === 'buyback').raw, null);
  assert.equal(siteSummary(flows, [{ category: 'WinRecycled' }], [], verified, 'all', { upgradeIncomeKnown: true }).find(row => row.key === 'buyback').raw, null);
});
