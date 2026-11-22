import assert from 'node:assert/strict';
import { drawWinners } from './draw.mjs';

assert.deepEqual(drawWinners([], 2), []);
assert.deepEqual(drawWinners(['a'], 2), ['a']);
assert.deepEqual(drawWinners(['a', 'b', 'c'], 2, n => n - 1), ['c', 'b']);
assert.deepEqual(drawWinners(['a', 'a', 'b'], 2, () => 0), ['a', 'b']);
console.log('daily draw tests passed');
