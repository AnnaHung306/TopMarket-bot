// Request-scoped batches, not a background worker or a wallet admission quota.
export async function forEachBatch(items, size, run) {
  for (let index = 0; index < items.length; index += size) {
    const outcomes = await Promise.allSettled(items.slice(index, index + size).map(run));
    const failed = outcomes.find(outcome => outcome.status === 'rejected');
    if (failed) throw failed.reason;
  }
}
