import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../dist/server/index.js',import.meta.url),'utf8');
const worker=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
assert.equal(typeof worker.default?.fetch,'function');
const response=await worker.default.fetch(new Request('http://localhost/'));
assert.equal(response.status,200);
assert((await response.text()).includes('Wallet report'));
console.log('PASS: portable ESM Worker and root response');
