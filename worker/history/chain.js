import { addr, auctionCall, auctionSeller, hex, rpcRequest, SIG, STAKE, USDC, words } from '../index.js';

const boxSignatures = [SIG.draw, SIG.refund, SIG.rescue, SIG.kept, SIG.won, SIG.buyback, SIG.treasuryUpdated,
  SIG.feeRecipientUpdated, SIG.tokenDraw, SIG.tokenBuyback];
const signatures = {
  card: boxSignatures,
  token: boxSignatures,
  market: [SIG.sold, SIG.offer, SIG.auction],
  stake: [SIG.staked, SIG.unstaked],
};

const units = { eth_call: 26, eth_getLogs: 60, eth_getTransactionReceipt: 20, eth_getCode: 26, eth_getStorageAt: 20, eth_chainId: 0, eth_getBlockByNumber: 20, alchemy_getAssetTransfers: 120 };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export function alchemy({ maxUnits = 8_000_000, perSecond = 6_000, maxMs = Infinity, beforeRequest = () => {} } = {}) {
  if (!process.env.ALCHEMY_API_KEY?.trim()) throw Error('Alchemy Base RPC is not configured');
  const stats = { units: 0, requests: 0, retries: 0, splits: 0, methods: {} };
  const deadline = performance.now() + maxMs;
  let nextTime = 0;
  async function request(payload, methods) {
    const cost = methods.reduce((sum, method) => sum + (units[method] ?? 80), 0);
    for (let attempt = 0; ; attempt++) {
      beforeRequest();
      if (Math.max(nextTime, performance.now()) >= deadline) throw Error('Alchemy sync time limit reached; saved chunks can resume');
      if (stats.units + cost > maxUnits) throw Error('Alchemy sync budget reached; saved chunks can resume');
      stats.units += cost;
      stats.requests++;
      for (const method of methods) stats.methods[method] = (stats.methods[method] || 0) + 1;
      const start = Math.max(nextTime, performance.now());
      nextTime = start + cost * 1_000 / perSecond;
      if (start > performance.now()) await delay(start - performance.now());
      beforeRequest();
      try {
        return await rpcRequest(payload);
      } catch (error) {
        if (attempt === 2 || ![429, 500, 502, 503, 504].includes(error.status)) throw error;
        stats.retries++;
        await delay(500 * (2 ** attempt));
      }
    }
  }

  async function rpc(method, params) {
    const response = await request({ jsonrpc: '2.0', id: 1, method, params }, [method]);
    if (response.error) throw Error(response.error.message);
    return response.result;
  }

  async function batch(calls, allowReverts = false) {
    const chunks = [];
    for (let i = 0; i < calls.length; i += 25) chunks.push(calls.slice(i, i + 25));
    const results = [];
    for (let i = 0; i < chunks.length; i += 8) {
      const pages = await Promise.all(chunks.slice(i, i + 8).map(async chunk => {
        const payload = chunk.map(([method, params], id) => ({ jsonrpc: '2.0', id, method, params }));
        const response = await request(payload, chunk.map(([method]) => method));
        if (!Array.isArray(response)) throw Error(response.error?.message || 'Invalid Alchemy batch');
        const byId = new Map(response.map(item => [item.id, item]));
        return chunk.map(([method], id) => {
          const item = byId.get(id);
          if (item && Object.hasOwn(item, 'result')) return item.result;
          if (allowReverts && method === 'eth_call' && /execution reverted/i.test(item?.error?.message || '')) return null;
          throw Error(item?.error?.message || 'Incomplete Alchemy batch');
        });
      }));
      results.push(...pages.flat());
    }
    return results;
  }
  return { rpc, batch, stats };
}

export async function getFilteredLogs(reader, filter, from, to) {
  try {
    const logs = await reader.rpc('eth_getLogs', [{ ...filter, fromBlock: hex(from), toBlock: hex(to) }]);
    if (!Array.isArray(logs) || logs.some(log => log.removed)) throw Error('Invalid finalized log response');
    return logs.map(compactLog);
  } catch (error) {
    if (from === to || !/log response size|more than [0-9,]+ (?:results|logs)|block range should work|response (?:is too large|size exceeded)|exceed(?:s|ed) (?:the )?max(?:imum)? (?:block|log)/i.test(error.message)) throw error;
    reader.stats.splits++;
    const mid = Math.floor((from + to) / 2);
    return [...await getFilteredLogs(reader, filter, from, mid), ...await getFilteredLogs(reader, filter, mid + 1, to)];
  }
}

export async function getSourceLogs(reader, sources, from, to) {
  const filters = new Map(sources.map(source => [source.address, signatures[source.kind]]));
  const topics = [...new Set([...filters.values()].flat())];
  const logs = await getFilteredLogs(reader, { address: [...filters.keys()], topics: [topics] }, from, to);
  return logs.filter(log => filters.get(log.address)?.includes(log.topics[0]));
}

export function compactLog({ address, topics, data, transactionHash, blockNumber, logIndex }) {
  return { address: address.toLowerCase(), topics, data, transactionHash, blockNumber, logIndex };
}

export function activeAuction(log) {
  return log.topics[0] === SIG.auction && BigInt(log.topics[2]) !== 0n && BigInt(log.data) > 0n;
}

export function callKey([target, block]) {
  return [target.to.toLowerCase(), Number(block), target.data].join(':');
}

export function evidencePlan(logs, includeTokenBuyback = false) {
  const receipts = new Set(), calls = new Map();
  const add = call => calls.set(callKey(call[1]), call);
  for (const log of logs) {
    const signature = log.topics[0], block = Number(log.blockNumber);
    const tokenBuyback = includeTokenBuyback && signature === SIG.tokenBuyback;
    if ([SIG.draw, SIG.tokenDraw, SIG.refund, SIG.rescue, SIG.buyback, SIG.kept, SIG.sold, SIG.offer].includes(signature) || tokenBuyback || activeAuction(log)) {
      receipts.add(log.transactionHash);
    }
    if ([SIG.draw, SIG.tokenDraw, SIG.refund, SIG.rescue, SIG.buyback].includes(signature) || tokenBuyback || log.dispositionCandidate) {
      const selectors = ['0x61d027b3', '0x7b9e618d'];
      if (signature === SIG.draw) selectors.push('0x46904840');
      for (const data of selectors) {
        for (const at of [block - 1, block]) add(['eth_call', [{ to: log.address, data }, hex(at)]]);
      }
    }
    if (signature === SIG.kept) add(['eth_call', [{ to: log.address, data: '0x80bfe883' + log.topics[1].slice(2) }, hex(block)]]);
    if (activeAuction(log)) add(auctionCall(log));
  }
  return { receipts: [...receipts], calls: [...calls.values()] };
}

export function callRecord([, [target, block]], result = null) {
  return { source: target.to, block: Number(block), input: target.data, result };
}

export function callRecordKey(record) {
  return [record.source, record.block, record.input].join(':');
}

export function receiptRecord(tx, receipt) {
  if (!receipt || receipt.transactionHash !== tx || receipt.status !== '0x1' || !Array.isArray(receipt.logs)) {
    throw Error('Finalized event has no successful receipt: ' + tx);
  }
  const logs = receipt.logs.filter(log => {
    const signature = log.topics[0];
    return [SIG.requestVia, SIG.payoutDeferred].includes(signature)
      || signature === SIG.tokenReleased && log.address.toLowerCase() === STAKE
      || signature === SIG.transfer && (log.address.toLowerCase() === USDC || log.topics.length === 4);
  });
  return { tx, receipt: { status: receipt.status, logs: logs.map(compactLog) } };
}

export function walletLog(log, evidence) {
  const signature = log.topics[0], data = words(log.data);
  let wallets = [];
  if ([SIG.draw, SIG.refund, SIG.rescue, SIG.buyback, SIG.tokenBuyback, SIG.kept].includes(signature)) {
    wallets = [addr(log.topics[2])];
    if (signature === SIG.buyback && data.length === 3) wallets.push(addr(data[1]));
  } else if ([SIG.won, SIG.tokenDraw, SIG.staked, SIG.unstaked].includes(signature)) {
    wallets = [addr(log.topics[3])];
  } else if ([SIG.sold, SIG.offer].includes(signature)) {
    wallets = [addr(log.topics[3]), addr(data[0])];
  } else if (activeAuction(log)) {
    wallets = [addr(log.topics[2]), auctionSeller(evidence.get(callKey(auctionCall(log)[1])))];
  }
  return { tx: log.transactionHash, position: Number(log.logIndex), block: Number(log.blockNumber),
    source: log.address, wallets: [...new Set(wallets.filter(Boolean))], log };
}
