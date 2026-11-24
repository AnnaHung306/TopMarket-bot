// Persist freshness with the evidence, not in process memory. A completed check
// is dated when the finalized head was fetched, even if its scan crosses midnight.
const VERSION = 1;
export const querySources = scope => scope === 'all' ? ['gavin', 'upgrade'] : [scope === 'upgrade' ? 'upgrade' : 'gavin'];
export function localDay(value = Date.now()) {
  const ms = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms + 8 * 3600_000).toISOString().slice(0, 10) : null;
}
function covers(coverage, through) {
  return coverage?.status === 'verified' && coverage.complete === true &&
    coverage.through === through && coverage.target === through;
}
export function sourceComplete(ledger, source, through) {
  if (source === 'gavin') return covers(ledger.coverage?.gavin, through);
  return Array.isArray(ledger.catalog) && ledger.catalog.filter(pool => pool.kind === 'upgrade').every(pool =>
    ledger.coverage?.[pool.id]?.status === 'unsupported' || covers(ledger.coverage?.[pool.id], through));
}
export function freshForDay(ledger, sources, day) {
  return sources.every(source => {
    const check = ledger.sourceChecks?.[source];
    return check?.version === VERSION && localDay(check.checkedAt) === day &&
      Number.isSafeInteger(check.through) && sourceComplete(ledger, source, check.through);
  });
}
export function recordSourceChecks(ledger, sources, through, checkedAt) {
  ledger.sourceChecks ||= {};
  for (const source of sources) if (sourceComplete(ledger, source, through)) {
    ledger.sourceChecks[source] = { version: VERSION, through, checkedAt };
  }
}
// A newer upgrade-only query must not make an older acquisition history appear
// current. Use the oldest relevant evidence timestamp in mixed-source reports.
export function reportAsOf(ledger, scope) {
  const sources = querySources(scope);
  if (scope === 'upgrade' && ledger.coverage?.gavin?.complete) sources.push('gavin');
  if (!sources.includes('upgrade') && ledger.events?.some(event => event.category === 'UpgradeRequested')) sources.push('upgrade');
  const times = sources.flatMap(source => source === 'gavin' ? [ledger.coverage?.gavin?.asOf]
    : (ledger.catalog || []).filter(pool => pool.kind === 'upgrade').map(pool => ledger.coverage?.[pool.id]?.asOf))
    .filter(time => Number.isFinite(Date.parse(time)));
  return times.length ? times.reduce((a, b) => Date.parse(a) < Date.parse(b) ? a : b) : ledger.asOf || null;
}
