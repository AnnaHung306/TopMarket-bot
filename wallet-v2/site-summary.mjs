// Gavin's reportMetrics order in worker/report/client.js, using its verified cash evidence.
// Kept-card settlements stay in staking income, as in displayWalletTotals.
const fields = [
  ['pack', '抽卡花費', ['pack']],
  ['marketPurchases', '市場買卡', ['purchaseGross']],
  ['buyback', '回購收入', ['buyback-claim-confirmed', 'WinRecycled']],
  ['airdrop', '空投', ['campaign-payout']],
  ['raffleParticipation', '奪寶參與', ['raffle-participation'], ['raffle-refund']],
  ['raffleIncome', '奪寶收入', ['raffle-income']],
  ['staking', '質押收益', ['staking-confirmed', 'staking-treasury', 'kept-disposal-confirmed']],
  ['sales', '市場賣卡', ['sales']],
];
const pendingCategories = {
  pack: ['pack'], marketPurchases: ['purchaseGross'], buyback: ['buyback-claim-pending', 'WinRecycled'],
  staking: ['staking-pending', 'kept-disposal-pending'], refund: ['refund-pending'],
};
const scopeFields = { all: null, packs: ['pack', 'buyback', 'refund'], upgrade: [],
  raffle: ['raffleParticipation', 'raffleIncome'], market: ['marketPurchases', 'sales'],
  buyback: ['buyback'], staking: ['staking'], campaign: ['airdrop'] };
export function siteSummary(flows, pending, events, coverage, scope = 'all', { upgradeIncomeKnown = false, raffleReferenceRaw = null } = {}) {
  if (!Object.hasOwn(scopeFields, scope)) throw Error('無效活動範圍');
  const sum = categories => flows.filter(row => categories.includes(row.category))
    .reduce((value, row) => value + BigInt(row.raw), 0n);
  const rows = fields.map(([key, label, categories, subtract = []]) => ({ key, label,
    raw: (sum(categories) - sum(subtract)).toString(), kind: 'cash',
    cards: key === 'raffleIncome' ? events.filter(row => row.category === 'raffle-card').length : 0 }));
  if (sum(['refund-confirmed']) > 0n || pending.some(row => row.category === 'refund-pending'))
    rows.push({ key: 'refund', label: '抽卡退款', raw: sum(['refund-confirmed']).toString(), kind: 'cash', cards: 0 });
  const raffle = rows.find(row => row.key === 'raffleIncome');
  raffle.cashRaw = raffle.raw;
  raffle.referenceRaw = raffle.cards ? raffleReferenceRaw : '0';
  if (raffle.cards) {
    raffle.label = '奪寶收入（含卡片估值）'; raffle.kind = 'cash-and-reference';
    raffle.raw = raffleReferenceRaw === null ? null : (BigInt(raffle.cashRaw) + BigInt(raffleReferenceRaw)).toString();
  }
  return rows.filter(row => scopeFields[scope] === null || scopeFields[scope].includes(row.key))
    .map(row => ({ ...row, raw: coverage?.status === 'verified' && coverage.complete === true &&
    (row.key !== 'buyback' || scope !== 'all' || upgradeIncomeKnown) &&
    !pending.some(item => (pendingCategories[row.key] || []).includes(item.category)) ? row.raw : null }));
}
