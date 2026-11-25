import { OUTCOME_LABELS, DELIVERY_LABELS, CATEGORY_LABELS, money, displayTime } from './model.mjs';

export const SCOPE_EMOJI = { all: '📊', packs: '📦', upgrade: '⬆️', raffle: '🎟️', market: '🛒', buyback: '♻️', staking: '🔒', campaign: '🎉' };
export const reportTitle = report => report.filter.scope === 'all' ? '錢包報告' : report.title + '報告';
export const reportNumber = raw => raw == null ? '待確認' : money(raw);
export const amount = raw => raw == null ? '待確認' : reportNumber(raw) + ' USDC';
export const upgradeIncome = upgrade => upgrade.laterProceedsRaw == null ? upgrade.incomePendingReason : amount(upgrade.laterProceedsRaw);
export const showUpgradeIncome = upgrade => upgrade.laterProceedsRaw == null || BigInt(upgrade.laterProceedsRaw) !== 0n;
export const holdingCost = holdings => amount(holdings.walletCount + holdings.stakedCount === holdings.unknownCostCount ? null : holdings.knownCostRaw);
export const showHoldings = report => report.filter.scope === 'all' || report.holdingsSummary.walletCount + report.holdingsSummary.stakedCount + report.holdingsSummary.unverifiedCount > 0;
export const summaryValue = row => reportNumber(row.raw);
export const headlineMetric = report => report.filter.scope === 'upgrade'
  ? { ...report.metrics.find(metric => metric.key === 'upgradeValue'), label: '卡牌升級活動價差' }
  : { key: 'cashNet', label: report.complete && !report.pending.length ? '淨收支' : '淨收支（部分）', raw: report.cash.netRaw };
export const visibleMetrics = report => [headlineMetric(report), ...(report.filter.scope === 'upgrade' ? [] : report.siteSummary),
  ...(report.filter.scope === 'upgrade' ? [] : report.metrics.filter(metric => metric.key === 'upgradeValue')),
  ...(showHoldings(report) ? [{ key: 'holdingsValue', label: '目前卡牌持倉（估值）', raw: report.holdingsSummary.valueRaw }] : [])].filter(Boolean);

const shortCard = label => label.length <= 55 ? label : label.slice(0, 54) + '…';
export function textReport(report) {
  const expanded = report.filter.detail !== 'summary', u = report.upgrade, h = report.holdingsSummary;
  const headline = headlineMetric(report);
  const lines = ['**' + SCOPE_EMOJI[report.filter.scope] + ' Top.Market · ' + reportTitle(report) + '**', '\x60' + report.wallet + '\x60', '🗓️ ' + report.range.label,
    '', '**' + (expanded ? '📋 詳細報表' : '📊 簡要報表') + '**',
    (headline.key === 'upgradeValue' ? '💎 ' : '💰 ') + headline.label + '：' + amount(headline.raw)];
  if (report.filter.scope !== 'upgrade') {
    lines.push('', '**📑 收支總覽（USDC）**');
    for (const row of report.siteSummary) lines.push(row.label + '：' + summaryValue(row));
  }
  if (['all', 'upgrade'].includes(report.filter.scope)) {
    lines.push('', '**⬆️ 卡牌升級**', '參與：' + u.requests + ' 次｜成功 ' + u.won + '｜失敗 ' + u.lost);
    const price = report.metrics.find(metric => metric.key === 'upgradeValue');
    if (report.filter.scope !== 'upgrade' && price) lines.push('💎 ' + price.label + '：' + amount(price.raw));
    const pending = [[u.pending, '待結算'], [u.rescued, '已救援'], [u.claimable, '待領取'], [u.awaitingChoice, '待選擇留卡或回購'], [u.unverifiedDelivery, '交付待核對']]
      .filter(([count]) => count).map(([count, label]) => label + ' ' + count);
    if (pending.length) lines.push(pending.join('｜'));
  }
  if (showHoldings(report)) lines.push('', '**🃏 目前卡牌持倉**', '參考價值：' + amount(h.valueRaw));
  const extra = [];
  if (expanded) {
    if (report.holdings.length) {
      extra.push('', '**🃏 持倉明細**');
      for (const lot of report.holdings.slice(0, 4)) extra.push(shortCard(lot.cardLabel) + '｜' +
        (lot.ownershipStatus !== 'history-checked' ? '持有待確認' : lot.custody ? '質押中' : '錢包持有') + '｜' + amount(lot.referenceRaw));
    }
    if (u.spins.length) {
      extra.push('', '**⬆️ 升級明細**');
      for (const spin of u.spins.slice(-3)) extra.push('#' + spin.request.spinId + ' ' + shortCard(spin.stakeLabel) + ' → ' + shortCard(spin.targetLabel) +
        ' · ' + OUTCOME_LABELS[spin.status] + '／' + DELIVERY_LABELS[spin.delivery]);
    }
    if (report.flows.length) extra.push('', '**🔎 交易證據**');
    for (const flow of report.flows.slice(-4)) extra.push((flow.direction === 'in' ? '+' : '-') + amount(flow.raw) + ' ' +
      (CATEGORY_LABELS[flow.category] || flow.category) + ' [查看交易](https://basescan.org/tx/' + flow.tx + ')');
  }
  const footer = ['', ...(!report.complete || report.pending.length ? ['資料狀態：部分資料待核對'] : []),
    '🕒 資料截至：' + displayTime(report.asOf)];
  for (const [index, line] of extra.entries()) {
    const next = line.startsWith('**') ? extra[index + 1] : null;
    if ([...lines, line, ...(next ? [next] : []), ...footer].join('\n').length > 1850) break;
    lines.push(line);
  }
  return [...lines, ...footer].join('\n');
}
