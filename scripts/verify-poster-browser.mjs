import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { summarizeWalletEvents } from '../worker/report/accounting.js';
import { renderGavinPoster, closePosterBrowser } from '../discord-gavin-poster.mjs';

try {
  if (process.platform === 'linux') {
    const family = execFileSync('fc-match', ['-f', '%{family}', ':lang=zh-tw'], { encoding: 'utf8' });
    assert.match(family, /Noto Sans CJK/, `Traditional Chinese font missing: ${family}`);
  }
  const image = await renderGavinPoster('0x' + '0'.repeat(40), {
    start: 1, through: 1, asOf: '2026-01-01T00:00:00.000Z',
    totals: summarizeWalletEvents([]),
  });
  assert.deepEqual([...image.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.ok(image.length > 10_000, 'Gavin poster is unexpectedly small');
  console.log('Gavin poster browser ready');
} finally {
  await closePosterBrowser();
}
