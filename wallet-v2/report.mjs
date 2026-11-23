import { SCOPES, OUTCOME_LABELS, DELIVERY_LABELS, CATEGORY_LABELS, dateRange, assetKey, money, displayTime } from './model.mjs';
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
  const report = {
    version: 2, wallet: ledger.wallet, filter, range: { label: range.label }, asOf: ledger.asOf || null,
    title: `${SCOPES[filter.scope]}${pool ? ' · ' + pool.name.slice(0, 100) : ''}`, poolName: pool?.name || null,
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
      spins: selectedSpins.filter(spin => within(spin.request) || spin.result && within(spin.result)).map(spin => ({
        ...spin, stakeLabel: describeCard(ledger, spin.request.stakeCollection, spin.request.stakeTokenId),
        targetLabel: describeCard(ledger, spin.request.targetCollection, spin.request.targetTokenId),
      })),
    },
    holdings: lineage.holdings.filter(lot => (!pool || (filter.dimension === 'origin' ? lot.originPoolId === pool.id : lot.poolIds?.includes(pool.id))) &&
      (filter.scope === 'all' || lot.activities.includes(filter.scope))).map(lot => ({ ...lot,
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
    byPool: [...byPool.values()].map(row => ({ ...totals(row), name: ledger.catalog.find(p => p.id === row.id)?.name || '未能唯一歸屬' })) };
  report.metrics = [
    { key: 'cashIn', label: '已核實 USDC 收入', raw: report.cash.inRaw, kind: 'cash' },
    { key: 'cashOut', label: '已核實 USDC 支出', raw: report.cash.outRaw, kind: 'cash' },
    { key: 'cashNet', label: complete && !pending.length ? '淨現金收支' : '已識別部分淨現金收支', raw: report.cash.netRaw, kind: 'cash' },
    { key: 'realized', label: unknownCostCount ? '可追溯已實現差額（已核實部分）' : '可追溯已實現收支差額', raw: report.realizedSummary.knownCount ? report.realizedSummary.knownPnlRaw : null, kind: 'expenditure' },
    ...(['all', 'upgrade'].includes(filter.scope) ? [{ key: 'upgradeValue', label: '升級已結算估值變化（非現金）',
      raw: coverage.some(c => c.key.startsWith('upgrade:') && c.status !== 'verified') ? null : report.upgrade.referenceChangeRaw, kind: 'reference' }] : []),
  ];
  return report;
}
export function describeCard(ledger, collection, tokenId) {
  const name = ledger.cards?.[assetKey(collection, tokenId)]?.name || ledger.cards?.[collection]?.name;
  return `${name || collection.slice(0, 10) + '…'} · NFT #${tokenId}`;
}
export function textReport(report) {
  const shortCard = label => {
    if (label.length <= 55) return label;
    const suffix = / · NFT #\d+$/.exec(label)?.[0] || '';
    return label.slice(0, 54 - suffix.length).trimEnd() + '…' + suffix;
  };
  const lines = [`**Top.Market 錢包分析 V2 · ${report.title}**`, `\`${report.wallet}\``,
    `${report.range.label} · ${report.filter.dimension === 'origin' ? '卡片來源歸屬' : '交易發生分類'}`,
    ...report.metrics.map(metric => `${metric.label}：${money(metric.raw)}${metric.raw == null ? '' : ' USDC'}`)];
  if (['all', 'upgrade'].includes(report.filter.scope)) {
    const u = report.upgrade;
    lines.push(`升級：本期申請 ${u.requests} 次｜本期結算成功 ${u.won}／失敗 ${u.lost}`,
      `待結算 ${u.pending}｜救援退卡 ${u.rescued}｜待領取 ${u.claimable}`,
      `本期結算成功率：${u.winRate === null ? '無已結算樣本' : (u.winRate * 100).toFixed(2) + '%'}`,
      `升級卡後續已核實實收：${money(u.laterProceedsRaw)}${u.laterProceedsRaw === null ? '' : ' USDC'}`);
  }
  const extra = [];
  if (report.filter.detail === 'detail') {
    for (const spin of report.upgrade.spins.slice(0, 4)) extra.push(`#${spin.request.spinId} ${shortCard(spin.stakeLabel)} → ${shortCard(spin.targetLabel)} · ${OUTCOME_LABELS[spin.status]} / ${DELIVERY_LABELS[spin.delivery]}`);
    for (const flow of report.flows.slice(-4)) extra.push(`${flow.direction === 'in' ? '+' : '-'}${money(flow.raw)} ${CATEGORY_LABELS[flow.category] || SCOPES[flow.activity]} · ${flow.tx.slice(0, 12)}…`);
  }
  if (report.filter.detail !== 'summary') {
    const s = report.realizedSummary;
    extra.push(`已核實取得支出差額 ${s.knownCount} 筆：實收 ${money(s.knownProceedsRaw)} − 取得支出 ${money(s.knownCostRaw)} USDC`);
    for (const group of report.analysis.byPool.slice(0, 3)) extra.push(`${group.name.slice(0, 100)}：淨現金 ${money(group.netRaw)} USDC`);
  }
  const footer = [`資料時間：${displayTime(report.asOf)}`, ...report.warnings.slice(0, 3).map(w => '⚠️ ' + w.slice(0, 220)),
    '現金、取得支出差額與估值分開呈現；不含 Gas，不作稅務成本認定。'];
  for (const line of extra) {
    if ([...lines, line, ...footer].join('\n').length > 1900) { lines.push('其餘逐筆明細與證據請見 CSV。'); break; }
    lines.push(line);
  }
  return [...lines, ...footer].join('\n');
}
