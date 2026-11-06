import { boxes, hex, MARKET, STAKE } from '../index.js';
import { readHistoricalCalls } from './multicall.js';
import { alchemy, callRecord, callRecordKey, evidencePlan, getSourceLogs, receiptRecord, walletLog } from './chain.js';
import { callRows, HistoryChunkTooLarge, initialize, listSources, publishedHead, publish, receiptKeys, rememberSources, saveChunk } from './store.js';

const initialSources = [
  { address: STAKE, kind: 'stake', deployment: 50634768 },
  { address: MARKET, kind: 'market', deployment: 50635450 },
];
const factoryDeployments = { card: 50636771, token: 52098220 };

async function deployments(reader, contracts, head) {
  const candidates = contracts.map(({ address, type }) => ({
    address, kind: type, before: factoryDeployments[type] - 1, at: head,
  }));
  while (true) {
    const pending = candidates.filter(item => item.at - item.before > 1);
    if (!pending.length) break;
    const mid = pending.map(item => Math.floor((item.before + item.at) / 2));
    const codes = await reader.batch(pending.map((item, i) => ['eth_getCode', [item.address, hex(mid[i])]]));
    pending.forEach((item, i) => {
      if (codes[i] === '0x') item.before = mid[i];
      else if (/^0x[0-9a-f]+$/i.test(codes[i])) item.at = mid[i];
      else throw Error('Invalid historical contract bytecode response');
    });
  }
  const boundaries = await reader.batch(candidates.flatMap(({ address, at }) => [
    ['eth_getCode', [address, hex(at - 1)]], ['eth_getCode', [address, hex(at)]],
  ]));
  return candidates.map(({ address, kind, at }, i) => {
    if (boundaries[i * 2] !== '0x' || !/^0x[0-9a-f]+$/i.test(boundaries[i * 2 + 1])) {
      throw Error('Cannot verify deployment boundary for ' + address);
    }
    return { address, kind, deployment: at };
  });
}

async function prepareEvidence(sql, reader, logs) {
  const plan = evidencePlan(logs);
  if (!plan.receipts.length && !plan.calls.length) return { receipts: [], calls: [], evidence: new Map() };
  const [knownReceipts, knownCalls] = await Promise.all([
    plan.receipts.length ? receiptKeys(sql, plan.receipts) : [],
    plan.calls.length ? callRows(sql, plan.calls.map(call => callRecord(call))) : [],
  ]);
  const receiptSet = new Set(knownReceipts.map(record => record.tx));
  const evidence = new Map(knownCalls.map(record => [callRecordKey(record), record.result]));
  const missingTxs = plan.receipts.filter(tx => !receiptSet.has(tx));
  const missingCalls = plan.calls.filter(call => !evidence.has(callRecordKey(callRecord(call))));
  const [receiptResponses, callResponses] = await Promise.all([
    reader.batch(missingTxs.map(tx => ['eth_getTransactionReceipt', [tx]])),
    readHistoricalCalls(reader, missingCalls),
  ]);
  const receipts = missingTxs.map((tx, i) => receiptRecord(tx, receiptResponses[i]));
  const calls = missingCalls.map((call, i) => callRecord(call, callResponses[i]));
  for (const record of calls) evidence.set(callRecordKey(record), record.result);
  return { receipts, calls, evidence };
}

async function commitPreparedChunk(sql, sources, { from, to, logs, receipts, calls, evidence }, assertLock) {
  const receiptsByTx = new Map(receipts.map(row => [row.tx, row]));
  const callsByKey = new Map(calls.map(row => [callRecordKey(row), row]));
  async function write(start, end, subset, receiptSubset, callSubset) {
    assertLock();
    try {
      await saveChunk(sql, sources, start, end, subset.map(log => walletLog(log, evidence)), receiptSubset, callSubset);
    } catch (error) {
      if (!(error instanceof HistoryChunkTooLarge) || start === end) throw error;
      const middle = Math.floor((start + end) / 2);
      for (const [lower, upper] of [[start, middle], [middle + 1, end]]) {
        const part = subset.filter(log => Number(log.blockNumber) >= lower && Number(log.blockNumber) <= upper);
        const plan = evidencePlan(part);
        const partReceipts = plan.receipts.map(tx => receiptsByTx.get(tx)).filter(Boolean);
        const partCalls = plan.calls.map(call => callsByKey.get(callRecordKey(callRecord(call)))).filter(Boolean);
        await write(lower, upper, part, partReceipts, partCalls);
      }
    }
  }
  await write(from, to, logs, receipts, calls);
}

export async function synchronize(sql, {
  reader = alchemy(), onProgress = () => {}, maxMs = Infinity, range = 25_000, parallelChunks = 1, through, assertLock = () => {},
} = {}) {
  if (!Number.isSafeInteger(range) || range < 1) throw Error('Invalid index chunk size');
  if (!Number.isSafeInteger(parallelChunks) || parallelChunks < 1 || parallelChunks > 3) throw Error('Invalid index chunk concurrency');
  const started = performance.now();
  const totals = { chunks: 0, logs: 0, receipts: 0, evidence: 0 };
  await initialize(sql);
  const [chain, finalized, previous] = await Promise.all([
    reader.rpc('eth_chainId', []), reader.rpc('eth_getBlockByNumber', ['finalized', false]), publishedHead(sql),
  ]);
  if (Number(chain) !== 8453 || !finalized?.hash) throw Error('Cannot verify finalized Base Mainnet head');
  const finalizedBlock = Number(finalized.number);
  const target = Math.min(through ?? finalizedBlock, finalizedBlock);
  const head = target === finalizedBlock ? finalized : await reader.rpc('eth_getBlockByNumber', [hex(target), false]);
  if (!head?.hash || Number(head.number) !== target) throw Error('Cannot verify the Base synchronization target');
  if (previous) {
    const checked = previous.block === target ? head : await reader.rpc('eth_getBlockByNumber', [hex(previous.block), false]);
    if (target < previous.block || checked?.hash !== previous.hash) throw Error('Published Base checkpoint no longer matches the chain');
  }
  if (target < factoryDeployments.token) throw Error('Finalized head predates project factories');
  const registered = await boxes(hex(target), reader.batch);
  if (!registered.length) throw Error('No factory contracts available at finalized head');
  const known = new Set((await listSources(sql)).map(source => source.address));
  assertLock();
  await rememberSources(sql, [
    ...initialSources.filter(source => !known.has(source.address)),
    ...await deployments(reader, registered.filter(source => !known.has(source.address)), target),
  ]);
  const sources = (await listSources(sql)).filter(source => source.deployment <= target);
  onProgress({ target, sources: sources.map(({ address, kind, deployment, through }) => ({ address, kind, deployment, through })) });
  let cursor = Math.min(...sources.map(source => source.through));
  while (cursor < target && performance.now() - started < maxMs) {
    const group = sources.filter(source => source.through === cursor);
    const next = Math.min(...sources.filter(source => source.through > cursor).map(source => source.through));
    const windows = [];
    const boundary = Math.min(target, next);
    for (let from = cursor + 1; from <= boundary && windows.length < parallelChunks; from += range) {
      windows.push({ from, to: Math.min(boundary, from + range - 1) });
    }
    const work = windows.map(async ({ from, to }) => {
      try {
        const logs = await getSourceLogs(reader, group, from, to);
        return { from, to, logs, ...await prepareEvidence(sql, reader, logs) };
      } catch (error) {
        return { error };
      }
    });
    // Fetch independent ranges concurrently, but commit a contiguous prefix in order.
    for (const job of work) {
      const result = await job;
      if (result.error) {
        await Promise.all(work);
        throw result.error;
      }
      const { from, to, logs, receipts, calls, evidence } = result;
      await commitPreparedChunk(sql, group, { from, to, logs, receipts, calls, evidence }, assertLock);
      for (const source of group) source.through = to;
      totals.chunks++;
      totals.logs += logs.length;
      totals.receipts += receipts.length;
      totals.evidence += calls.length;
      onProgress({ from, to, logs: logs.length, receipts: receipts.length, ...reader.stats });
    }
    cursor = Math.min(...sources.map(source => source.through));
  }
  if (cursor >= target || (previous && cursor > previous.block)) {
    const block = Math.min(cursor, target);
    const snapshot = block === target ? head : await reader.rpc('eth_getBlockByNumber', [hex(block), false]);
    if (!snapshot?.hash || Number(snapshot.number) !== block) throw Error('Cannot verify finalized index snapshot');
    const collections = await reader.rpc('eth_call', [{ to: STAKE, data: '0xd57f966b' }, hex(block)]);
    assertLock();
    await publish(sql, snapshot, Number(BigInt(collections)));
  }
  return {
    target, through: (await publishedHead(sql))?.block ?? null, ...totals,
    seconds: (performance.now() - started) / 1_000, alchemy: reader.stats,
  };
}
