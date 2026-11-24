import test from 'node:test';
import assert from 'node:assert/strict';
import { createReader } from '../reader.mjs';
const response = result => Response.json({ jsonrpc: '2.0', id: 1, result });
test('explicit provider never receives an Alchemy key and CU estimates do not impose a usage quota', async () => {
  const calls = [];
  const reader = createReader({ rpcUrl: 'https://explicit-rpc.example', alchemyKey: 'unit-test-key', fetchImpl: async (url, init) => {
    calls.push({ url, headers: init.headers }); return response('0x1');
  } });
  reader.stats.units = 1000000000;
  assert.equal(await reader.rpc('eth_getCode', ['0x' + '1'.repeat(40), 'latest']), '0x1');
  assert.equal(calls[0].headers.authorization, undefined);
  assert.equal(reader.stats.units, 1000000020);
  assert.throws(() => createReader({ alchemyKey: '' }), /明確設定/);
});
test('provider log-range errors split the same provider without losing boundary blocks', async () => {
  const urls = [];
  const reader = createReader({ rpcUrl: 'https://explicit-rpc.example', fetchImpl: async (url, init) => {
    urls.push(url); const filter = JSON.parse(init.body).params[0];
    const from = Number(filter.fromBlock), to = Number(filter.toBlock);
    return to - from > 1 ? Response.json({ error: { message: 'exceed maximum block range: 2' } })
      : response(Array.from({ length: to - from + 1 }, (_, i) => ({ blockNumber: '0x' + (from + i).toString(16) })));
  } });
  const logs = await reader.rpc('eth_getLogs', [{ fromBlock: '0x0', toBlock: '0x3' }]);
  assert.deepEqual(logs.map(log => Number(log.blockNumber)), [0, 1, 2, 3]);
  assert.equal(reader.stats.splits, 1);
  assert.ok(urls.every(url => url === 'https://explicit-rpc.example'));
});
test('transient HTTP retry is bounded and never switches the configured endpoint', async () => {
  const urls = [];
  const reader = createReader({ rpcUrl: 'https://explicit-rpc.example', fetchImpl: async url => {
    urls.push(url); return new Response('', { status: 503, headers: { 'retry-after': '0.001' } });
  } });
  await assert.rejects(reader.rpc('eth_chainId', []), /HTTP 503/);
  assert.equal(urls.length, 3); assert.equal(reader.stats.retries, 2);
  assert.ok(urls.every(url => url === urls[0]));
});
test('Alchemy HTTP 400 range errors retain their JSON-RPC message and can be paged', async () => {
  const reader = createReader({ rpcUrl: 'https://explicit-rpc.example', fetchImpl: async (_url, init) => {
    const filter = JSON.parse(init.body).params[0];
    return Number(filter.toBlock) > Number(filter.fromBlock)
      ? Response.json({ error: { message: 'Log response size exceeded' } }, { status: 400 })
      : response([{ blockNumber: filter.fromBlock }]);
  } });
  assert.equal((await reader.rpc('eth_getLogs', [{ fromBlock: '0x1', toBlock: '0x2' }])).length, 2);
});
test('HTTP 200 batch throttling retries only rejected items and preserves successful results', async () => {
  const sent = [];
  const reader = createReader({ rpcUrl: 'https://explicit-rpc.example', fetchImpl: async (_url, init) => {
    const calls = JSON.parse(init.body); sent.push(calls);
    return Response.json(calls.map(call => sent.length === 1 && call.id === 1
      ? { id: call.id, error: { code: 429, message: 'Your app has exceeded its compute units per second capacity' } }
      : { id: call.id, result: call.params[0] }));
  } });
  assert.deepEqual(await reader.batch([['eth_call', ['a']], ['eth_call', ['b']]]), ['a', 'b']);
  assert.equal(sent.length, 2); assert.deepEqual(sent[1].map(call => call.id), [1]);
  assert.equal(reader.stats.methods.eth_call, 3); assert.equal(reader.stats.retries, 1);
});
