// Explicit endpoint selection only. No switch to another provider on failure.
const units = { eth_call: 26, eth_getLogs: 60, eth_getTransactionReceipt: 20, eth_getCode: 26,
  eth_getStorageAt: 20, eth_chainId: 0, eth_getBlockByNumber: 20, alchemy_getAssetTransfers: 120 };
export function createReader({ rpcUrl, alchemyKey = process.env.ALCHEMY_API_KEY, fetchImpl = fetch, signal, concurrency = 12,
  batchSize = 25, minIntervalMs = 0 } = {}) {
  if (!rpcUrl && !alchemyKey?.trim()) throw Error('V2 需要明確設定 Alchemy key 或 RPC URL');
  const url = rpcUrl || 'https://base-mainnet.g.alchemy.com/v2';
  if (!/^https:\/\//.test(url)) throw Error('RPC endpoint must use HTTPS');
  const stats = { units: 0, requests: 0, retries: 0, splits: 0, methods: {}, provider: rpcUrl ? 'explicit-rpc' : 'alchemy' };
  if (!Number.isInteger(concurrency) || concurrency < 1 || !Number.isInteger(batchSize) || batchSize < 1 || batchSize > 25 || minIntervalMs < 0) throw Error('Invalid RPC transport settings');
  let active = 0, nextRequest = 0, maxLogRange;
  const waiting = [];
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function send(payload, methods) {
    if (active >= concurrency) await new Promise(resolve => waiting.push(resolve)); else active++;
    try {
      for (let attempt = 0; ; attempt++) {
        signal?.throwIfAborted();
        const sendAt = Math.max(Date.now(), nextRequest);
        nextRequest = sendAt + minIntervalMs;
        if (sendAt > Date.now()) await delay(sendAt - Date.now());
        stats.requests++;
        for (const method of methods) { stats.units += units[method] ?? 80; stats.methods[method] = (stats.methods[method] || 0) + 1; }
        let response;
        try {
          response = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json',
            ...(!rpcUrl ? { authorization: `Bearer ${alchemyKey.trim()}` } : {}) }, body: JSON.stringify(payload),
            signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000) });
        } catch { throw Error('RPC 連線失敗；未切換其他資料來源'); }
        if (response.ok) return response.json();
        const failure = await response.json().catch(() => null);
        // Alchemy can use HTTP 400 for normal JSON-RPC range/result-size errors.
        // Preserve the structured error so the same-provider range parser can handle it.
        if (response.status === 400 && failure?.error) return failure;
        if (attempt >= 2 || ![429, 500, 502, 503, 504].includes(response.status))
          throw Error(`RPC ${[...new Set(methods)].join(',')} HTTP ${response.status}${failure?.error?.message ? ': ' + safeMessage(failure.error.message) : ''}`);
        stats.retries++;
        const retry = Number(response.headers.get('retry-after'));
        await delay(Number.isFinite(retry) && retry > 0 ? retry * 1000 : 500 * 2 ** attempt);
      }
    } finally { const next = waiting.shift(); if (next) next(); else active--; }
  }
  const safeMessage = message => String(message || 'RPC error').replaceAll(alchemyKey || '\u0000', '[redacted]').replace(/https?:\/\/\S+/g, '[rpc-url]');
  const throttled = error => error && (Number(error.code) === 429 || /compute units per second|rate limit|too many requests/i.test(error.message || ''));
  async function rpc(method, params) {
    const requested = params[0];
    if (method === 'eth_getLogs' && maxLogRange && /^0x[\da-f]+$/i.test(requested?.fromBlock || '') && /^0x[\da-f]+$/i.test(requested?.toBlock || '')) {
      const from = Number(requested.fromBlock), to = Number(requested.toBlock);
      if (to - from + 1 > maxLogRange) {
        const result = [];
        for (let start = from; start <= to; start += maxLogRange) result.push(...await rpc(method,
          [{ ...requested, fromBlock: '0x' + start.toString(16), toBlock: '0x' + Math.min(to, start + maxLogRange - 1).toString(16) }]));
        return result;
      }
    }
    let data;
    for (let attempt = 0; ; attempt++) {
      data = await send({ jsonrpc: '2.0', id: 1, method, params }, [method]);
      if (!throttled(data.error) || attempt >= 2) break;
      stats.retries++; await delay(1000 * 2 ** attempt);
    }
    if (data.error) {
      const message = safeMessage(data.error.message);
      const filter = params[0];
      if (method === 'eth_getLogs' && /^0x[\da-f]+$/i.test(filter?.fromBlock || '') && /^0x[\da-f]+$/i.test(filter?.toBlock || '') &&
        /block range|range.*(?:large|limit|exceed)|too many (?:results|logs)|more than [\d,]+ (?:results|logs)|response.*(?:large|size)/i.test(message)) {
        const from = Number(filter.fromBlock), to = Number(filter.toBlock);
        if (from < to) {
          stats.splits++;
          const limit = /(?:max(?:imum)?\s+block\s+range\s*:?\s*|(?:at most|limit(?:ed)? to)\s*)([\d,]+)/i.exec(message);
          if (limit && Number.isSafeInteger(Number(limit[1].replaceAll(',', ''))) && Number(limit[1].replaceAll(',', '')) > 0) {
            maxLogRange = Number(limit[1].replaceAll(',', ''));
            if (to - from + 1 > maxLogRange) return rpc(method, params);
          }
          const mid = Math.floor((from + to) / 2);
          return [...await rpc(method, [{ ...filter, toBlock: '0x' + mid.toString(16) }]),
            ...await rpc(method, [{ ...filter, fromBlock: '0x' + (mid + 1).toString(16) }])];
        }
      }
      throw Error(message);
    }
    if (!Object.hasOwn(data, 'result')) throw Error('Incomplete RPC response');
    return data.result;
  }
  async function batch(calls, allowReverts = false) {
    if (batchSize === 1) {
      const results = [];
      for (const [method, params] of calls) {
        try { results.push(await rpc(method, params)); }
        catch (error) { if (allowReverts && method === 'eth_call' && /execution reverted/i.test(error.message)) results.push(null); else throw error; }
      }
      return results;
    }
    const chunks = [];
    for (let i = 0; i < calls.length; i += batchSize) chunks.push(calls.slice(i, i + batchSize));
    const results = [];
    for (let i = 0; i < chunks.length; i += 4) {
      results.push(...(await Promise.all(chunks.slice(i, i + 4).map(async chunk => {
        const output = new Array(chunk.length);
        let pending = chunk.map(([method, params], id) => ({ jsonrpc: '2.0', id, method, params }));
        for (let attempt = 0; pending.length; attempt++) {
          let data = await send(pending, pending.map(call => call.method));
          if (!Array.isArray(data) && throttled(data.error)) data = pending.map(call => ({ id: call.id, error: data.error }));
          if (!Array.isArray(data)) throw Error(safeMessage(data.error?.message || 'Invalid RPC batch'));
          const byId = new Map(data.map(item => [item.id, item])), retry = [];
          for (const call of pending) {
            const item = byId.get(call.id);
            if (item && Object.hasOwn(item, 'result')) output[call.id] = item.result;
            else if (allowReverts && call.method === 'eth_call' && /execution reverted/i.test(item?.error?.message)) output[call.id] = null;
            else if (throttled(item?.error) && attempt < 2) retry.push(call);
            else throw Error(safeMessage(item?.error?.message || 'Incomplete RPC batch'));
          }
          pending = retry;
          if (pending.length) { stats.retries++; await delay(1000 * 2 ** attempt); }
        }
        return output;
      }))).flat());
    }
    return results;
  }
  return { rpc, batch, stats, parallelLogSplits: true };
}
