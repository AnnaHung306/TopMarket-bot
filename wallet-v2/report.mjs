import { SCOPES, dateRange, assetKey, displayPoolName } from './model.mjs';
export { textReport } from './report-text.mjs';
import { cashFlows } from './gavin.mjs';
import { upgradeSpins } from './upgrade.mjs';
import { traceLineage } from './lineage.mjs';

const sum = (rows, field) => rows.reduce((total, row) => total + BigInt(row[field] ?? '0'), 0n).toString();
export function buildReport(ledger, selection = {}, { now = Date.now() } = {}) {
  const filter = { scope: 'all', poolId: null, dimension: 'location', period: 'all', detail: 'summary', ...selection };
  if (!SCOPES[filter.scope] || !['location', 'origin'].includes(filter.dimension) || !['summary', 'analysis', 'detail'].includes(filter.detail)) throw Error('無效報表篩選');
  const pool = filter.poolId ? ledger.catalog.find(p => p.id === filter.poolId) : null;
  if (filter.poolId && !pool) throw Error('找不到指定的活動池或卡池');
  const range = dateRange(filter, now);
  const within = row => Number.isFinite(row.timestamp) && row.timestamp >= range.start && row.timestamp < range.end;
  const poolMatches = row => !pool || (filter.dimension === 'origin' ? row.originPoolId === pool.id : row.poolId === pool.id);
  const lineagePoolMatches = row => !pool || (filter.dimension === 'origin' ? row.originPoolId === pool.id
    : pool.kind === 'upgrade' ? row.assetPoolIds?.includes(pool.id) || row.poolId === pool.id : row.poolId === pool.id);
  const scopeMatches = row => filter.scope === 'all' || row.activity === filter.scope ||
    filter.scope === 'packs' && row.activity === 'buyback' && row.poolId?.startsWith('pack:');
  const cash = cashFlows(ledger.events, ledger.transfers, ledger.wallet, ledger.catalog);
  const spins = upgradeSpins(ledger.events, ledger.transfers, ledger.wallet);
  const lineage = traceLineage(ledger, cash.flows, spins);
  const flows = cash.flows.filter(row => within(row) && poolMatches(row) && scopeMatches(row));
  const realized = lineage.realized.filter(row => within(row) && lineagePoolMatches(row) &&
    (filter.scope === 'all' || row.activity === filter.scope || filter.scope === 'upgrade' && row.activities.includes('upgrade') ||
      filter.scope === 'packs' && row.activities.includes('packs')));
  const selectedSpins = ['all', 'upgrade'].includes(filter.scope) ? spins.filter(spin => !pool ||
    (filter.dimension === 'origin' ? spin.originPoolId === pool.id : spin.poolId === pool.id)) : [];
  const cohort = selectedSpins.filter(spin => within(spin.request));
  const settled = selectedSpins.filter(spin => spin.result && within(spin.result) && ['won', 'lost'].includes(spin.status));
  const comparable = settled.filter(spin => spin.request.valueDecimals === 6);
  const consumedRaw = comparable.reduce((value, spin) => value + BigInt(spin.request.stakeValueRaw), 0n);
  const awardedRaw = comparable.filter(spin => spin.status === 'won').reduce((value, spin) => value + BigInt(spin.request.targetValueRaw), 0n);
  const won = settled.filter(spin => spin.status === 'won').length, lost = settled.length - won;
  const requirements = filter.scope === 'upgrade' ? [] : ['gavin'];
  if (['all', 'upgrade'].includes(filter.scope)) requirements.push(...ledger.catalog.filter(p => p.kind === 'upgrade' &&
    (!pool || filter.dimension === 'origin' || p.id === pool.id)).map(p => p.id));
  const coverage = requirements.map(key => ({ key, ...(ledger.coverage[key] || { status: 'not-scanned', complete: false }) }));
  const complete = coverage.every(source => source.status === 'verified' && source.complete);
  const pending = cash.pending.filter(row => within(row) && scopeMatches(row));
  const unknownCostCount = realized.filter(row => row.pnlRaw === null).length;
  const laterProceedsKnown = Boolean(ledger.coverage.gavin?.complete) && coverage.every(c => c.status === 'verified' && c.complete);
  const proceedsFromUpgrade = cash.flows.filter(row => within(row) && row.direction === 'in' && row.assetActivities?.includes('upgrade') && lineagePoolMatches(row));
  const upgradeRealized = realized.filter(row => row.activities.includes('upgrade'));
  const report = {
    version: 2, wallet: ledger.wallet, filter, range: { label: range.label }, asOf: ledger.asOf || null,
    title: `${SCOPES[filter.scope]}${pool ? ' · ' + displayPoolName(pool).slice(0, 100) : ''}`, poolName: pool ? displayPoolName(pool) : null,
    complete, coverage, flows, pending, realized,
    cash: { inRaw: sum(flows.filter(row => row.direction === 'in'), 'raw'), outRaw: sum(flows.filter(row => row.direction === 'out'), 'raw') },
    realizedSummary: { knownPnlRaw: sum(realized.filter(row => row.pnlRaw !== null), 'pnlRaw'),
      knownCount: realized.length - unknownCostCount, unknownCostCount, proceedsRaw: sum(realized, 'proceedsRaw') },
    upgrade: { requests: cohort.length, settled: settled.length, won, lost,
      pending: cohort.filter(spin => spin.status === 'pending').length,
      rescued: selectedSpins.filter(spin => spin.status === 'rescued' && within(spin.result)).length,
      claimable: cohort.filter(spin => spin.delivery === 'claimable').length,
      unverifiedDelivery: cohort.filter(spin => ['won', 'rescued'].includes(spin.status) && spin.delivery === 'unverified').length,
      winRate: settled.length ? won / settled.length : null,
      consumedRaw: consumedRaw.toString(), awardedRaw: awardedRaw.toString(), referenceChangeRaw: (awardedRaw - consumedRaw).toString(),
      valueUnknownCount: settled.length - comparable.length, laterProceedsRaw: laterProceedsKnown ? sum(proceedsFromUpgrade, 'raw') : null,
      realizedCount: upgradeRealized.length, unknownCostCount: upgradeRealized.filter(row => row.pnlRaw === null).length,
      realizedPnlRaw: upgradeRealized.some(row => row.pnlRaw !== null) ? sum(upgradeRealized.filter(row => row.pnlRaw !== null), 'pnlRaw') : null,
      spins: selectedSpins.filter(spin => within(spin.request) || spin.result && within(spin.result)).map(spin => ({
        ...spin, stakeLabel: describeCard(ledger, spin.request.stakeCollection, spin.request.stakeTokenId),
        targetLabel: describeCard(ledger, spin.request.targetCollection, spin.request.targetTokenId),
      })),
    },
    holdings: lineage.holdings.filter(lot => (!pool || (filter.dimension === 'origin' ? lot.originPoolId === pool.id : lot.poolIds?.includes(pool.id))) &&
      (filter.scope === 'all' || lot.activities.includes(filter.scope) || filter.scope === 'staking' && lot.custody)).map(lot => ({ ...lot,
      cardLabel: describeCard(ledger, lot.collection, lot.tokenId),
      ownershipStatus: ledger.ownershipCoverage?.[lot.collection] ? 'history-checked' : 'receipt-observed-only',
      ownershipCheckedThrough: ledger.ownershipCoverage?.[lot.collection] || null })),
    unassignedOriginCount: cash.flows.filter(row => within(row) && !row.originPoolId).length,
    warnings: [...new Set([...(ledger.warnings || []), ...(!complete ? ['所選範圍尚未完整核實；數字僅為已識別部分，未知活動未當成零收益'] : []),
      ...(pending.length ? [`${pending.length} 筆金額待核對，未納入現金總額`] : []),
      ...(unknownCostCount ? [`${unknownCostCount} 筆結算的取得支出未知，未當成零成本`] : []),
      ...(filter.dimension === 'origin' ? ['來源卡池為另一分析角度，不可與交易分類加總；未知來源未強行分攤'] : []),
      ...(filter.scope === 'packs' ? ['抽卡視圖包含同卡池對應回購；不可與回購視圖重複加總'] : []),
      ...(!laterProceedsKnown && ['all', 'upgrade'].includes(filter.scope) ? ['尚未取得完整抽卡／市場歷史；升級卡片的取得支出與後續實收仍為未知'] : []),
      ...(settled.some(s => s.request.valueDecimals !== 6) ? ['部分歷史估值精度未核實為 6 位，未混加'] : [])])],
  };
  report.cash.netRaw = (BigInt(report.cash.inRaw) - BigInt(report.cash.outRaw)).toString();
  report.realizedSummary.knownCostRaw = sum(realized.filter(row => row.costRaw !== null), 'costRaw');
  report.realizedSummary.knownProceedsRaw = sum(realized.filter(row => row.costRaw !== null), 'proceedsRaw');
  const confirmedHoldings = report.holdings.filter(lot => lot.ownershipStatus === 'history-checked');
  report.holdingsSummary = { walletCount: confirmedHoldings.filter(lot => !lot.custody).length,
    stakedCount: confirmedHoldings.filter(lot => lot.custody).length,
    unverifiedCount: report.holdings.length - confirmedHoldings.length,
    knownCostRaw: sum(confirmedHoldings.filter(lot => lot.costRaw !== null), 'costRaw'),
    unknownCostCount: confirmedHoldings.filter(lot => lot.costRaw === null).length };
  const byActivity = new Map(), byPool = new Map();
  for (const flow of flows) {
    const poolId = filter.dimension === 'origin' ? flow.originPoolId : flow.poolId;
    for (const [map, key] of [[byActivity, flow.activity], [byPool, poolId || 'unassigned']]) {
      if (!map.has(key)) map.set(key, { id: key, count: 0, inRaw: '0', outRaw: '0' });
      const row = map.get(key), field = flow.direction === 'in' ? 'inRaw' : 'outRaw';
      row[field] = (BigInt(row[field]) + BigInt(flow.raw)).toString(); row.count++;
    }
  }
  const totals = row => ({ ...row, netRaw: (BigInt(row.inRaw) - BigInt(row.outRaw)).toString() });
  report.analysis = { byActivity: [...byActivity.values()].map(row => ({ ...totals(row), name: SCOPES[row.id] })),
    byPool: [...byPool.values()].map(row => { const pool = ledger.catalog.find(p => p.id === row.id); return { ...totals(row), name: pool ? displayPoolName(pool) : '其他收益' }; }) };
  report.metrics = [
    ...(filter.scope === 'upgrade' ? [] : [
      { key: 'cashIn', label: '收入', raw: report.cash.inRaw, kind: 'cash' },
      { key: 'cashOut', label: '支出', raw: report.cash.outRaw, kind: 'cash' },
      { key: 'cashNet', label: complete && !pending.length ? '淨收支' : '淨收支（已核對部分）', raw: report.cash.netRaw, kind: 'cash' }]),
    ...(report.realized.length ? [{ key: 'realized', label: unknownCostCount ? '已實現收益（已核對部分）' : '已實現收益', raw: report.realizedSummary.knownCount ? report.realizedSummary.knownPnlRaw : null, kind: 'expenditure' }] : []),
    ...(['all', 'upgrade'].includes(filter.scope) && (filter.scope === 'upgrade' || selectedSpins.length || coverage.some(c => c.key.startsWith('upgrade:') && c.status !== 'verified')) ? [{ key: 'upgradeValue', label: '卡片估值變化',
      raw: coverage.some(c => c.key.startsWith('upgrade:') && c.status !== 'verified') ? null : report.upgrade.referenceChangeRaw, kind: 'reference' }] : []),
  ];
  return report;
}
export function describeCard(ledger, collection, tokenId) {
  const name = ledger.cards?.[assetKey(collection, tokenId)]?.name || ledger.cards?.[collection]?.name;
  return `${name || '卡片'} · NFT #${tokenId}`;
}
