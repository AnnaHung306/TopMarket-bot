// One FIFO gate shared by production readers. This limits simultaneous network
// requests, never daily usage or the number of wallets allowed to query.
export function createRpcConcurrency(limit = 12) {
  if (!Number.isInteger(limit) || limit < 1) throw Error('Invalid shared RPC concurrency');
  let active = 0;
  const waiting = [];
  function release() {
    const next = waiting.shift();
    if (next) next(); else active--;
  }
  return async function acquire(signal) {
    signal?.throwIfAborted();
    if (active < limit) active++;
    else await new Promise((resolve, reject) => {
      const grant = () => { signal?.removeEventListener('abort', abort); resolve(); };
      const abort = () => { const index = waiting.indexOf(grant); if (index >= 0) waiting.splice(index, 1); reject(signal.reason); };
      waiting.push(grant);
      signal?.addEventListener('abort', abort, { once: true });
    });
    let released = false;
    return () => { if (!released) { released = true; release(); } };
  };
}
