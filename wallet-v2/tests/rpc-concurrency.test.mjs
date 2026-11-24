import test from 'node:test';
import assert from 'node:assert/strict';
import { createRpcConcurrency } from '../rpc-concurrency.mjs';
import { createReader } from '../reader.mjs';

test('different wallets share a network concurrency gate without any usage quota', async () => {
  const acquireRpc = createRpcConcurrency(3);
  let active = 0, maximum = 0, calls = 0;
  const readers = Array.from({ length: 20 }, () => createReader({ acquireRpc, rpcUrl: 'https://explicit-rpc.example',
    fetchImpl: async () => { active++; maximum = Math.max(maximum, active); calls++;
      await new Promise(resolve => setTimeout(resolve, 2)); active--; return Response.json({ result: '0x1' }); } }));
  readers[0].stats.units = 1000000000;
  await Promise.all(readers.flatMap(reader => Array.from({ length: 3 }, () => reader.rpc('eth_getCode', ['0x1', 'latest']))));
  assert.equal(calls, 60); assert.equal(maximum, 3); assert.equal(readers[0].stats.units, 1000000060);
});

test('aborted waiting requests and double release cannot leak or invent permits', async () => {
  const acquire = createRpcConcurrency(1), first = await acquire(), controller = new AbortController();
  const canceled = acquire(controller.signal); controller.abort(Error('cancelled'));
  await assert.rejects(canceled, /cancelled/);
  const next = acquire(); first(); first();
  const release = await next; let granted = false;
  const third = acquire().then(value => { granted = true; return value; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(granted, false);
  release(); (await third)();
});

test('an RPC failure releases the shared permit for the next wallet', async () => {
  const acquireRpc = createRpcConcurrency(1);
  const bad = createReader({ acquireRpc, rpcUrl: 'https://explicit-rpc.example', fetchImpl: async () => { throw Error('offline'); } });
  const good = createReader({ acquireRpc, rpcUrl: 'https://explicit-rpc.example', fetchImpl: async () => Response.json({ result: '0x1' }) });
  const results = await Promise.allSettled([bad.rpc('eth_chainId', []), good.rpc('eth_chainId', [])]);
  assert.equal(results[0].status, 'rejected'); assert.equal(results[1].value, '0x1');
});
