import assert from 'node:assert/strict';

process.env.ALCHEMY_API_KEY = 'test-key-not-a-secret';
const { alchemy } = await import('./worker/history/chain.js');
const originalFetch = globalThis.fetch;
try {
  let requests = 0;
  globalThis.fetch = async (_url, options) => {
    requests++;
    assert.equal(options.headers.authorization, 'Bearer test-key-not-a-secret');
    return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: [] }) };
  };
  const reader = alchemy({ maxUnits: 120, maxMs: 1_000, perSecond: 100_000 });
  await reader.rpc('eth_getLogs', [{}]);
  await reader.rpc('eth_getLogs', [{}]);
  await assert.rejects(reader.rpc('eth_getLogs', [{}]), /Alchemy sync budget reached/);
  assert.equal(reader.stats.units, 120);
  assert.equal(requests, 2);
  console.log('PASS: Alchemy CU ceiling stops additional requests');

  globalThis.fetch = (_url, { signal }) => new Promise((_, reject) => {
    const timer = setTimeout(() => reject(Error('mock request hung')), 1_000);
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(Error('mock request aborted')); }, { once: true });
  });
  const start = performance.now();
  await assert.rejects(alchemy({ maxUnits: 1_000, maxMs: 40 }).rpc('eth_getLogs', [{}]), /mock request aborted/);
  assert.ok(performance.now() - start < 200);
  console.log('PASS: Alchemy request obeys scan deadline');
} finally {
  globalThis.fetch = originalFetch;
  delete process.env.ALCHEMY_API_KEY;
}
