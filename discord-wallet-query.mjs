import { setTimeout as delay } from 'node:timers/promises';

// Gavin's web client reads the saved summary, then refreshes cache hits and
// resumed scans to the latest finalized block.
async function queryWallet(readPage, wallet) {
  const usage = { units: 0, requests: 0, retries: 0, splits: 0 };
  let afterBlock;
  let pages = 0;
  for (;;) {
    let resumed = false;
    let gotPage = false;
    for (;;) {
      const result = await readPage(wallet, afterBlock);
      for (const key of Object.keys(usage)) usage[key] += result.usage?.[key] ?? 0;
      if (result.page) {
        if (!gotPage) resumed = result.progress.resumed;
        gotPage = true;
        pages++;
      }
      if (result.waiting) await delay(1500);
      if (!result.ready) continue;

      if (resumed || (afterBlock === undefined && result.cached && !gotPage)) {
        afterBlock = result.snapshot.through;
        break;
      }
      return { snapshot: result.snapshot, usage, pages };
    }
  }
}

export function createWalletQuery(readPage) {
  const active = new Map();
  return (wallet, queryId) => {
    const existing = active.get(wallet);
    if (existing) return existing;
    const query = queryWallet(readPage, wallet)
      .then(result => ({ ...result, queryId }))
      .finally(() => active.delete(wallet));
    active.set(wallet, query);
    return query;
  };
}
