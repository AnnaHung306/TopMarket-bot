import { SCOPES } from './model.mjs';

// This is a partition of actual USDC flows. The standalone packs view also
// includes buybacks; adding those views would count the same income twice.
export function activitySummary(flows, pending, coverage, upgradeCoverage) {
  const groups = new Map(Object.entries(SCOPES).filter(([id]) => id !== 'all').map(([id, name]) =>
    [id, { id, name, count: 0, inRaw: '0', outRaw: '0', pendingCount: 0 }]));
  for (const flow of flows) {
    const group = groups.get(flow.activity);
    if (!group) throw Error('收支活動缺少已登錄分類，未產生會漏項的報告');
    const field = flow.direction === 'in' ? 'inRaw' : 'outRaw';
    group[field] = (BigInt(group[field]) + BigInt(flow.raw)).toString(); group.count++;
  }
  for (const row of pending) if (groups.has(row.activity)) groups.get(row.activity).pendingCount++;
  const verified = source => source?.status === 'verified' && source.complete === true;
  return [...groups.values()].map(group => {
    const complete = !group.pendingCount && (group.id === 'upgrade'
      ? upgradeCoverage.every(verified) : verified(coverage.gavin));
    return { ...group, complete, inRaw: complete ? group.inRaw : null, outRaw: complete ? group.outRaw : null,
      netRaw: complete ? (BigInt(group.inRaw) - BigInt(group.outRaw)).toString() : null };
  });
}
