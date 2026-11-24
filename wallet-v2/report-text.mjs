import { SCOPES, OUTCOME_LABELS, DELIVERY_LABELS, CATEGORY_LABELS, money, displayTime } from './model.mjs';

export const SCOPE_EMOJI = { all: '📊', packs: '📦', upgrade: '⬆️', raffle: '🎟️', market: '🛒', buyback: '♻️', staking: '🔒', campaign: '🎉' };
export const METRIC_EMOJI = { cashIn: '📥', cashOut: '📤', cashNet: '💰', realized: '🏆', upgradeValue: '💎' };
export const amount = raw => raw == null ? '待確認' : `${money(raw)} USDC`;
export const upgradeProfit = upgrade => upgrade.realizedCount ? amount(upgrade.realizedPnlRaw) : upgrade.laterProceedsRaw == null ? '待確認' : '尚未實現';
export const holdingCost = holdings => amount(holdings.walletCount + holdings.stakedCount === holdings.unknownCostCount ? null : holdings.knownCostRaw);
export const showHoldings = report => ['all', 'packs', 'upgrade', 'market', 'staking'].includes(report.filter.scope) || report.holdings.length;
const shortCard = label => {
  if (label.length <= 55) return label;
  const suffix = / · NFT #\d+$/.exec(label)?.[0] || '';
  return label.slice(0, 54 - suffix.length).trimEnd() + '…' + suffix;
};
export function textReport(report) {
  const expanded = report.filter.detail !== 'summary';
  const lines = [`**${SCOPE_EMOJI[report.filter.scope]} Top.Market · ${report.title}**`, `\`${report.wallet}\``,
    `🗓️ ${report.range.label}`, '', `**${expanded ? '📋 詳細報表' : '📊 簡要報表'}**`,
    ...report.metrics.map(metric => `${METRIC_EMOJI[metric.key]} ${metric.label}：${amount(metric.raw)}`)];
  if (showHoldings(report)) {
    const h = report.holdingsSummary;
    lines.push('', '**🃏 目前卡牌持倉**', `👛 錢包 ${h.walletCount} 張｜🔒 質押 ${h.stakedCount} 張`);
    if (h.walletCount + h.stakedCount) lines.push(`💳 持倉成本：${holdingCost(h)}${h.unknownCostCount ? `（${h.unknownCostCount} 張待確認）` : ''}`);
    if (h.unverifiedCount) lines.push(`🔎 ${h.unverifiedCount} 張持有狀態待確認`);
  }
  if (['all', 'upgrade'].includes(report.filter.scope) && (report.filter.scope === 'upgrade' || report.upgrade.spins.length)) {
    const u = report.upgrade;
    lines.push('', '**⬆️ 卡牌升級**', `🎮 參與 ${u.requests} 次｜✅ 成功 ${u.won}｜❌ 失敗 ${u.lost}`,
      `📥 升級卡後續收入：${amount(u.laterProceedsRaw)}`,
      `🏆 升級後已實現收益：${upgradeProfit(u)}${u.unknownCostCount ? `（${u.unknownCostCount} 筆成本待確認）` : ''}`);
    const pending = [[u.pending, '⏳ 待結算'], [u.rescued, '🛟 已救援'], [u.claimable, '🎁 待領取']]
      .filter(([count]) => count).map(([count, label]) => `${label} ${count}`);
    if (pending.length) lines.push(pending.join('｜'));
  }
  const extra = [];
  if (expanded) {
    if (report.holdings.length) {
      extra.push('', '**🃏 持倉明細**');
      for (const lot of report.holdings.slice(0, 4)) extra.push(`${lot.ownershipStatus !== 'history-checked' ? '🔎' : lot.custody ? '🔒' : '🃏'} ${shortCard(lot.cardLabel)}｜成本 ${amount(lot.costRaw)}`);
    }
    if (report.upgrade.spins.length) {
      extra.push('', '**⬆️ 升級明細**');
      for (const spin of report.upgrade.spins.slice(0, 3)) extra.push(`${spin.status === 'won' ? '✅' : spin.status === 'lost' ? '❌' : '⏳'} #${spin.request.spinId} ${shortCard(spin.stakeLabel)} → ${shortCard(spin.targetLabel)} · ${OUTCOME_LABELS[spin.status]}／${DELIVERY_LABELS[spin.delivery]}`);
    }
    if (report.flows.length) extra.push('', '**💸 收支明細**');
    for (const flow of report.flows.slice(-3)) extra.push(`${flow.direction === 'in' ? '📥 +' : '📤 -'}${money(flow.raw)} ${CATEGORY_LABELS[flow.category] || SCOPES[flow.activity]}`);
    for (const group of report.analysis.byPool.slice(0, 3)) extra.push(`📦 ${group.name.slice(0, 80)}：${amount(group.netRaw)}`);
  }
  const footer = ['', ...(!report.complete ? ['🔎 部分資料待核對'] : []),
    ...(report.pending.length ? [`🔎 ${report.pending.length} 筆金額待核對`] : []),
    ...(report.realizedSummary.unknownCostCount ? [`🔎 ${report.realizedSummary.unknownCostCount} 筆成本未知`] : []),
    `🕒 更新：${displayTime(report.asOf)}`];
  for (const line of extra) {
    if ([...lines, line, ...footer].join('\n').length > 1850) { lines.push('📄 完整明細請見 CSV。'); break; }
    lines.push(line);
  }
  if (expanded && lines.at(-1) !== '📄 完整明細請見 CSV。') lines.push('📄 完整明細請見 CSV。');
  return [...lines, ...footer].join('\n');
}
