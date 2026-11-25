import { directWalletReportBatch, WALLET_HISTORY_START } from '../worker/wallet-direct.js';
import { eventId, address, USDC } from './model.mjs';

export { WALLET_HISTORY_START };
export const scanGavin = (reader, wallet, from, to) => directWalletReportBatch(wallet, from, to, reader);
const activities = {
  pack: 'packs', 'refund-confirmed': 'packs', 'refund-pending': 'packs',
  sales: 'market', saleGross: 'market', purchaseGross: 'market', selfTrade: 'market',
  'buyback-claim-confirmed': 'buyback', 'buyback-claim-evidence': 'buyback', 'buyback-claim-pending': 'buyback', buyback: 'buyback',
  'staking-confirmed': 'staking', 'staking-treasury': 'staking', 'staking-pending': 'staking',
  'kept-disposal-confirmed': 'staking', 'kept-disposal-pending': 'staking', staked: 'staking', unstaked: 'staking',
  'campaign-payout': 'campaign',
};
export function normalizeGavin(events) {
  return events.map(event => ({ ...event, legacyId: event.id,
    id: `${eventId(event.tx, event.logIndex)}:${event.category}`, contract: address(event.contract),
    activity: event.category.startsWith('raffle-') ? 'raffle' : activities[event.category] || 'packs' }));
}

// A nominal marketplace purchase becomes cash only when same-transaction USDC proves it.
// Existing Gavin verified draw/payout categories retain their original evidence.
export function cashFlows(events, transfers, wallet, catalog) {
  const byLegacyId = new Map(events.filter(e => e.legacyId).map(e => [e.legacyId, e]));
  const byContract = new Map(catalog.map(pool => [pool.address, pool]));
  const inflows = new Set(['refund-confirmed', 'sales', 'buyback-claim-confirmed', 'staking-confirmed',
    'staking-treasury', 'kept-disposal-confirmed', 'campaign-payout', 'raffle-income', 'raffle-refund']);
  const outflows = new Set(['raffle-participation']);
  const used = new Set(), flows = [], pending = [];
  const recyclePayments = new Map(events.filter(event => event.category === 'WinRecycled' && event.recycleVerified)
    .map(event => [event.recycleTransferId, event.id]));
  const paidByTx = new Map(), usdcById = new Map();
  for (const transfer of transfers) if (transfer.kind === 'usdc') {
    usdcById.set(transfer.id, transfer);
    if (transfer.from === wallet) {
      if (!paidByTx.has(transfer.tx)) paidByTx.set(transfer.tx, []);
      paidByTx.get(transfer.tx).push(transfer);
    }
  }
  const purchasesByTx = new Map();
  for (const event of events.filter(e => e.category === 'purchaseGross' && e.currency === USDC)) {
    if (!purchasesByTx.has(event.tx)) purchasesByTx.set(event.tx, []);
    purchasesByTx.get(event.tx).push(event);
  }
  for (const event of events) {
    if (event.raw != null && !/^\d+$/.test(String(event.raw))) throw Error('Invalid unsigned USDC amount in evidence');
    if (event.category === 'WinRecycled' && !event.recycleVerified) {
      pending.push({ ...event, reason: event.paymentReason }); continue;
    }
    // The physical USDC transfer can also have a generic Gavin treasury label.
    // The verified spin attribution wins; never count that payment twice.
    const assignedRecycle = recyclePayments.get(eventId(event.tx, event.logIndex));
    if (assignedRecycle && assignedRecycle !== event.id) continue;
    if (event.raw === null || event.raw === undefined || event.category === 'selfTrade') continue;
    let direction = null, proofIds = [], cashKey = eventId(event.tx, event.logIndex);
    if (event.category === 'WinRecycled' && event.recycleVerified) {
      direction = 'in'; cashKey = event.recycleTransferId; proofIds = [cashKey];
    }
    if (inflows.has(event.category)) direction = 'in';
    if (outflows.has(event.category)) direction = 'out';
    if (event.category === 'pack' && event.paymentVerified) {
      direction = 'out'; cashKey = event.id;
      proofIds = (paidByTx.get(event.tx) || []).map(t => t.id);
    }
    if (event.category === 'purchaseGross' && event.currency === USDC) {
      const group = purchasesByTx.get(event.tx);
      const paid = paidByTx.get(event.tx) || [];
      const expected = group.reduce((sum, e) => sum + BigInt(e.raw), 0n);
      const actual = paid.reduce((sum, t) => sum + BigInt(t.raw), 0n);
      if (expected === actual && paid.length) {
        direction = 'out'; cashKey = event.id; proofIds = paid.map(t => t.id);
      } else pending.push({ ...event, reason: '市場買入事件未與唯一完整 USDC 支出核對，未納入現金或成本' });
    }
    if (!direction) {
      if (event.category.endsWith('-pending') || event.category === 'pack' && !event.paymentVerified) pending.push(event);
      continue;
    }
    if (used.has(cashKey)) continue;
    used.add(cashKey);
    const evidence = byLegacyId.get(event.claimId);
    const relatedContract = evidence?.contract || event.contract;
    const pool = byContract.get(relatedContract);
    const proof = usdcById.get(eventId(event.tx, event.logIndex));
    if (proof) proofIds = [proof.id];
    flows.push({ id: cashKey, eventId: event.id, tx: event.tx, block: event.block, logIndex: event.logIndex,
      timestamp: event.timestamp, activity: event.activity, category: event.category, direction, raw: event.raw,
      poolId: event.poolId || pool?.id || null, collection: event.collection, tokenId: event.tokenId,
      proofIds, legacyId: event.legacyId, saleIds: event.saleIds || [], claimId: event.claimId,
      spinId: event.spinId,
      verification: ['purchaseGross', 'WinRecycled'].includes(event.category) ? 'receipt-matched' : 'gavin-verified',
    });
  }
  return { flows, pending };
}
