import { linkAcquisitionCosts, STAKE } from '../worker/index.js';
import { assetKey, eventId, ordered } from './model.mjs';
import { acquisitionIndex, uniqueDrawForWin } from './acquisition-evidence.mjs';

const receiptKey = id => { if (!id) return null; const [tx, position] = id.split(':'); return eventId(tx, position); };
const unknown = reason => ({ costRaw: null, originPoolId: null, activities: [], evidence: [], reason });
export function traceLineage(ledger, flows, spins) {
  const wallet = ledger.wallet;
  const legacy = ledger.events.filter(e => e.legacyId).map(e => ({ ...e, v2Id: e.id, id: e.legacyId }));
  const byLegacy = new Map(legacy.map(e => [e.id, e]));
  const index = acquisitionIndex(legacy);
  const winEvents = event => index.wins.get(`${event.contract}:${event.winId}`) || [];
  const winsFor = event => winEvents(event).filter(e => e.category === 'won');
  const transfersByTx = new Map(), transferIds = new Set(), stakeTransfers = new Set();
  for (const transfer of ledger.transfers) {
    if (!transfersByTx.has(transfer.tx)) transfersByTx.set(transfer.tx, []);
    transfersByTx.get(transfer.tx).push(transfer);
    if (transfer.kind === 'nft' && [wallet, STAKE].includes(transfer.from) && transfer.to !== wallet)
      transferIds.add(`${transfer.tx}:${assetKey(transfer.collection, transfer.tokenId)}`);
  }
  for (const event of legacy) if (event.category === 'staked') stakeTransfers.add(`${event.tx}:${assetKey(event.collection, event.tokenId)}`);
  const acquisitions = new Map(), lots = new Map(), reserved = new Map(), captured = new Map(), realized = [];
  // Give Gavin's unchanged verifier the complete relevant request/settlement group,
  // avoiding a full-wallet rescan for every kept card.
  const costs = new Map();
  for (const event of legacy.filter(e => e.category === 'kept')) {
    const wins = winsFor(event);
    const relevant = [...winEvents(event), ...wins.flatMap(win => index.requests.get(`${win.contract}:${win.requestId}`) || [])];
    const cost = linkAcquisitionCosts(relevant).find(row => row.keptId === event.id);
    if (cost) costs.set(event.id, cost);
  }
  for (const event of legacy.filter(e => e.category === 'kept' && e.acquisitionVerified)) {
    const cost = costs.get(event.id);
    const matchingWins = winsFor(event);
    const linked = matchingWins.length === 1 ? uniqueDrawForWin(legacy, matchingWins[0], index) : null;
    const settlements = winEvents(event).filter(e => ['kept', 'buyback'].includes(e.category));
    const adapterDraw = linked?.adapterEvidence?.verified && settlements.length === 1 && matchingWins[0].block <= event.block &&
      matchingWins[0].collection === event.collection && matchingWins[0].tokenId === event.tokenId ? linked : null;
    const raw = cost?.acquisitionCostRaw ?? adapterDraw?.raw ?? null;
    acquisitions.set(receiptKey(event.nftReceiptId), {
      costRaw: raw, originPoolId: `pack:${event.contract}`, poolIds: [`pack:${event.contract}`], continuityCollections: [event.collection],
      activities: ['packs'], evidence: [event.id, ...(cost?.drawId ? [cost.drawId] : adapterDraw ? [adapterDraw.id] : [])],
      reason: raw == null ? '取得支出未能唯一核實' : '唯一已核實抽卡支出；非稅務成本認定',
    });
  }
  for (const flow of flows.filter(f => f.category === 'pack')) flow.originPoolId = flow.poolId;
  for (const flow of flows.filter(f => f.category === 'purchaseGross')) {
    const matches = (transfersByTx.get(flow.tx) || []).filter(t => t.kind === 'nft' && t.to === wallet &&
      t.collection === flow.collection && t.tokenId === flow.tokenId);
    if (matches.length === 1) acquisitions.set(matches[0].id, { costRaw: flow.raw, originPoolId: null,
      poolIds: [flow.poolId].filter(Boolean), continuityCollections: [flow.collection], activities: ['market'], evidence: [flow.eventId, ...flow.proofIds], reason: '同筆 USDC 付款與 NFT 收取已核實' });
  }
  const stakeByTransfer = new Map(spins.filter(s => s.stakeTransferId).map(s => [s.stakeTransferId, s]));
  const deliveryByTransfer = new Map(spins.filter(s => s.deliveryTransferId).map(s => [s.deliveryTransferId, s]));
  const outcomeById = new Map(spins.filter(s => s.result).map(s => [s.result.id, s]));
  const recycleSpins = new Map(spins.filter(spin => spin.resolution?.category === 'WinRecycled').map(spin => [spin.resolution.id, spin]));
  const disposed = new Set();
  const record = (flow, bases, assets, reason) => {
    if (disposed.has(flow.id)) return;
    disposed.add(flow.id);
    const continuityKnown = bases.every(basis => (basis.continuityCollections || []).every(collection =>
      Number(ledger.ownershipCoverage?.[collection] ?? -1) >= Number(flow.block ?? 0)));
    const costKnown = bases.length > 0 && bases.every(basis => basis.costRaw !== null) && continuityKnown;
    const costRaw = costKnown ? bases.reduce((sum, basis) => sum + BigInt(basis.costRaw), 0n).toString() : null;
    const origins = [...new Set(bases.map(basis => basis.originPoolId))];
    const originPoolId = origins.length === 1 ? origins[0] : null;
    const activities = [...new Set([flow.activity, ...bases.flatMap(basis => basis.activities)])];
    const poolIds = [...new Set([flow.poolId, ...bases.flatMap(basis => basis.poolIds || [])].filter(Boolean))];
    flow.originPoolId = originPoolId;
    flow.assetActivities = activities;
    flow.assetPoolIds = poolIds;
    realized.push({ id: flow.id, tx: flow.tx, timestamp: flow.timestamp, activity: flow.activity,
      poolId: flow.poolId, originPoolId, activities, assetPoolIds: poolIds, assets, proceedsRaw: flow.raw, costRaw,
      pnlRaw: costRaw === null ? null : (BigInt(flow.raw) - BigInt(costRaw)).toString(),
      evidence: [...new Set(bases.flatMap(basis => basis.evidence))], reason: costKnown ? '已核實實收減可追溯取得支出；非稅務損益'
        : !continuityKnown ? '持有歷史尚未完整核對，未認列取得支出差額' : reason });
  };
  const saleAssets = flow => {
    if (flow.collection && flow.tokenId !== undefined) return [{ collection: flow.collection, tokenId: flow.tokenId }];
    return flow.saleIds.map(id => byLegacy.get(id)).filter(e => e?.collection && e.tokenId !== undefined)
      .map(e => ({ collection: e.collection, tokenId: e.tokenId }));
  };
  const saleFlows = flows.filter(f => ['sales', 'kept-disposal-confirmed', 'buyback-claim-confirmed'].includes(f.category));
  const timeline = [
    ...ledger.transfers.filter(t => t.kind === 'nft').map(t => ({ ...t, action: 'transfer' })),
    ...spins.filter(s => s.result).map(s => ({ ...s.result, action: 'outcome' })),
    ...saleFlows.map(flow => ({ ...flow, action: 'sale', flow })),
    ...flows.filter(flow => flow.category === 'WinRecycled').map(flow => ({ ...flow, action: 'recycle', flow })),
  ].sort(ordered);
  for (const action of timeline) {
    if (action.action === 'recycle') {
      const spin = recycleSpins.get(action.flow.eventId);
      if (!spin) throw Error('Upgrade recycle payment has no matching spin');
      const basis = reserved.get(spin.id) || unknown('升級投入卡片的取得支出未知');
      record(action.flow, [basis], [assetKey(spin.request.stakeCollection, spin.request.stakeTokenId)], basis.reason);
      continue;
    }
    if (action.action === 'outcome') {
      const spin = outcomeById.get(action.id), basis = reserved.get(spin.id) || unknown('投入卡片的取得成本或持有連續性未知');
      if (spin.status === 'lost') record({ id: `lost:${spin.id}`, tx: action.tx, timestamp: action.timestamp,
        block: action.block, activity: 'upgrade', poolId: spin.poolId, raw: '0' }, [basis], [assetKey(spin.request.stakeCollection, spin.request.stakeTokenId)], basis.reason);
      continue;
    }
    if (action.action === 'sale') {
      const flow = action.flow, assets = saleAssets(flow);
      const bases = assets.map(asset => {
        const key = assetKey(asset.collection, asset.tokenId);
        const proof = transferIds.has(`${flow.tx}:${key}`);
        if (!proof) return unknown('出售卡片的轉出證據未知');
        return captured.get(`${flow.tx}:${key}`) || lots.get(key) || unknown('出售卡片的取得支出或持有連續性未知');
      });
      // An immediate buyback can have no retained NFT. Only a unique legacy draw chain establishes expenditure.
      if (!assets.length && flow.category === 'buyback-claim-confirmed') {
        const claim = byLegacy.get(flow.claimId);
        const wins = claim ? winsFor(claim) : [];
        const candidate = wins.length === 1 ? uniqueDrawForWin(legacy, wins[0], index) : null;
        const draws = candidate ? [candidate] : [];
        if (draws.length === 1) bases.push({ costRaw: draws[0].raw, originPoolId: `pack:${draws[0].contract}`,
          poolIds: [`pack:${draws[0].contract}`], activities: ['packs'], evidence: [draws[0].id, wins[0].id, claim.id] });
      }
      record(flow, bases, assets.map(a => assetKey(a.collection, a.tokenId)), '缺少唯一取得支出，未知部分未當成零成本');
      continue;
    }
    const key = assetKey(action.collection, action.tokenId);
    if (action.from === wallet && action.to === wallet) continue;
    if (action.from === wallet || action.from === STAKE && lots.get(key)?.custody) {
      const basis = lots.get(key) || unknown('轉出卡片的取得支出未知');
      captured.set(`${action.tx}:${key}`, basis);
      const spin = stakeByTransfer.get(action.id);
      if (spin) {
        spin.originPoolId = basis.originPoolId;
        reserved.set(spin.id, { ...basis, poolIds: [...new Set([...(basis.poolIds || []), spin.poolId])],
          activities: [...new Set([...basis.activities, 'upgrade'])], evidence: [...basis.evidence, spin.request.id] });
        lots.delete(key);
      } else if (action.to === STAKE && action.from === wallet && stakeTransfers.has(`${action.tx}:${key}`)) {
        lots.set(key, { ...basis, custody: true });
      } else lots.delete(key);
    }
    if (action.to === wallet) {
      const spin = deliveryByTransfer.get(action.id);
      let basis;
      if (spin) {
        basis = reserved.get(spin.id) || unknown('升級投入卡片的取得支出未知');
        basis = { ...basis, continuityCollections: [...new Set([...(basis.continuityCollections || []), collectionForSpin(spin)])],
          activities: [...new Set([...basis.activities, 'upgrade'])], evidence: [...basis.evidence, spin.result.id, action.id],
          referenceRaw: spin.status === 'won' ? spin.request.targetValueRaw : spin.request.stakeValueRaw,
          valueDecimals: spin.request.valueDecimals, referenceTimestamp: spin.request.timestamp };
      } else if (action.from === STAKE && lots.get(key)?.custody) basis = { ...lots.get(key), custody: false };
      else basis = acquisitions.get(action.id) || unknown('外部轉入或持有鏈不完整，取得支出未知');
      lots.set(key, { ...basis, collection: action.collection, tokenId: action.tokenId, lastTransferId: action.id });
    }
  }
  return { realized, holdings: [...lots.values()], reserved: [...reserved.entries()].filter(([id]) => spins.find(s => s.id === id)?.status === 'pending')
    .map(([id, basis]) => ({ id, ...basis })) };
}
const collectionForSpin = spin => spin.status === 'rescued' ? spin.request.stakeCollection : spin.request.targetCollection;
