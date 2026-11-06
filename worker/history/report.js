import { decodeMarket, MARKET, settleWallet, SIG, word } from '../index.js';
import { activeAuction, callKey, callRecord, callRecordKey, evidencePlan } from './chain.js';

export async function indexSummary(sql) {
  const [row] = await sql`SELECT h.block, h.as_of, h.collections, min(s.deployment) AS start,
    jsonb_agg(jsonb_build_object('address', s.address, 'type', s.kind) ORDER BY s.deployment, s.address)
      FILTER (WHERE s.kind IN ('card', 'token')) AS contracts
    FROM wallet_index_head h CROSS JOIN wallet_index_sources s WHERE s.published
    GROUP BY h.block, h.as_of, h.collections`;
  return row;
}

export async function indexProgress(sql) {
  const [row] = await sql`SELECT min(deployment) AS start, min(through) AS through FROM wallet_index_sources`;
  return row;
}

export async function walletReport(sql, wallet, from, to) {
  const [row] = await sql`WITH activity AS MATERIALIZED (
    SELECT a.* FROM wallet_index_logs a
    JOIN wallet_index_sources s ON s.address = a.source AND s.published
    WHERE a.wallets @> ARRAY[${wallet}]::text[] AND a.block BETWEEN ${from} AND ${to}
  ), relevant_calls AS (
    SELECT DISTINCT source, block FROM activity
    UNION SELECT DISTINCT source, block - 1 FROM activity
  ), updates AS (
    SELECT a.log FROM (SELECT DISTINCT source, block FROM activity) blocks
    JOIN wallet_index_logs a USING (source, block)
    WHERE a.log -> 'topics' ->> 0 IN (${SIG.treasuryUpdated}, ${SIG.feeRecipientUpdated})
  )
  SELECT h.block, h.collections, h.as_of,
    (SELECT jsonb_agg(log ORDER BY block, position) FROM activity) AS logs,
    (SELECT jsonb_agg(r) FROM (SELECT DISTINCT tx FROM activity) a JOIN wallet_index_receipts r USING (tx)) AS receipts,
    (SELECT jsonb_agg(c) FROM relevant_calls a JOIN wallet_index_calls c USING (source, block)) AS calls,
    (SELECT jsonb_agg(log) FROM updates) AS updates
  FROM wallet_index_head h
  WHERE ${to} <= h.block AND ${from} >= (SELECT min(deployment) FROM wallet_index_sources WHERE published)`;
  if (!row) return null;

  const logs = row.logs || [];
  const receipts = new Map((row.receipts || []).map(({ tx, receipt }) => [tx, receipt]));
  const calls = new Map((row.calls || []).map(record => [callRecordKey(record), record.result]));
  const expected = evidencePlan(logs);
  if (expected.receipts.some(tx => !receipts.has(tx)) || expected.calls.some(call => !calls.has(callRecordKey(callRecord(call))))) {
    throw Error('Indexed wallet data is missing settlement evidence');
  }
  const updates = new Map();
  for (const log of row.updates || []) {
    const key = log.address + ':' + Number(log.blockNumber);
    const group = updates.get(key) || [];
    group.push(log);
    updates.set(key, group);
  }
  const rpc = async (method, params) => {
    if (method === 'eth_call') return calls.get(callKey(params));
    if (method === 'eth_getTransactionReceipt') return receipts.get(params[0]);
    if (method === 'eth_getLogs') {
      const [{ address, fromBlock, topics }] = params;
      const signatures = [topics[0]].flat();
      return (updates.get(address + ':' + Number(fromBlock)) || []).filter(log => signatures.includes(log.topics[0]));
    }
    throw Error('Unsupported indexed evidence method');
  };
  const reader = { rpc, batch: batch => Promise.all(batch.map(([method, params]) => rpc(method, params))) };
  const market = logs.filter(log => log.address === MARKET && [SIG.sold, SIG.offer].includes(log.topics[0]))
    .map(log => decodeMarket(log, wallet)).filter(Boolean);
  const auctions = logs.filter(activeAuction);
  const rewards = logs.filter(log => log.topics[0] === SIG.buyback);
  const activity = logs.filter(log => log.address !== MARKET && (
    log.topics[0] !== SIG.buyback || log.topics[2] === word(wallet)
  ));
  // Only the winner gets the nominal buyback line. Both participants can get a cash payout.
  const report = await settleWallet(wallet, activity, market, auctions, rewards, reader);
  return { from, to, ...report, collections: row.collections, collectionsError: null, indexedThrough: row.block, asOf: row.as_of };
}
