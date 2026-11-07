export const WALLET_HOLDINGS_PAGE_SIZE = 240;

export function summarizeWalletEvents(input) {
  const events = [...new Map(input.map(event => [event.id, event])).values()];
  const sum = selected => selected.filter(event => event.raw !== null)
    .reduce((total, event) => total + BigInt(event.raw), 0n).toString();
  const categoryEvents = category => events.filter(event => event.category === category);
  const sumCategory = category => sum(categoryEvents(category));
  const count = category => String(events.filter(event => event.category === category).length);
  const staking = events.filter(event => ['staking-confirmed', 'staking-treasury'].includes(event.category));
  return {
    pack: sum(categoryEvents('pack').filter(event => event.paymentVerified === true)),
    marketPurchases: sumCategory('purchaseGross'),
    refund: sumCategory('refund-confirmed'),
    sales: sumCategory('sales'),
    staking: sum(staking),
    keptDisposal: sumCategory('kept-disposal-confirmed'),
    buybackReceived: sumCategory('buyback-claim-confirmed'),
    stakingCount: String(staking.length),
    keptDisposalCount: count('kept-disposal-confirmed'),
    buybackCount: count('buyback-claim-confirmed'),
    pendingPacks: String(events.filter(event => event.category === 'pack' && event.paymentVerified !== true).length),
    pendingBuybacks: count('buyback-claim-pending'),
    pendingStaking: count('staking-pending'),
    pendingKeptDisposal: count('kept-disposal-pending'),
    pendingRefunds: count('refund-pending'),
  };
}

export function addWalletTotals(previous, next) {
  return Object.fromEntries(Object.entries(next).map(([field, value]) =>
    [field, (BigInt(previous[field] ?? '0') + BigInt(value)).toString()]));
}

export function displayWalletTotals(record, events) {
  const pack = BigInt(record.pack), marketPurchases = BigInt(record.marketPurchases);
  const refund = BigInt(record.refund), sales = BigInt(record.sales);
  const staking = BigInt(record.staking), buybackReceived = BigInt(record.buybackReceived);
  const keptDisposal = BigInt(record.keptDisposal ?? '0');
  const stakingInflow = staking + keptDisposal;
  const inflows = refund + sales + buybackReceived + stakingInflow;
  const outflows = pack + marketPurchases;
  return {
    events, pack, marketPurchases, refund, sales, stakingInflow, buybackReceived, keptDisposal, inflows, outflows, net: inflows - outflows,
    stakingInflowKnown: BigInt(record.stakingCount) + BigInt(record.keptDisposalCount ?? '0') > 0n,
    buybackKnown: BigInt(record.buybackCount) > 0n,
    pendingPacks: Number(record.pendingPacks),
    pendingBuybacks: Number(record.pendingBuybacks),
    pendingStakingInflow: Number(record.pendingStaking) + Number(record.pendingKeptDisposal ?? 0),
    pendingRefunds: Number(record.pendingRefunds),
  };
}
