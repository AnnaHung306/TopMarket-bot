import assert from 'node:assert/strict';
import vm from 'node:vm';
import worker from './worker/index.js';
const html=await(await worker.fetch(new Request('https://local/'))).text();
const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
const nodes=new Map();
const ctx={document:{getElementById:id=>{if(!nodes.has(id))nodes.set(id,{style:{}});return nodes.get(id);}}};
vm.createContext(ctx);
vm.runInContext(script+`\nsave=(text)=>{globalThis.exported=text;};state.events=[{id:'test',category:'refund-pending',amount:null,raw:null,block:1,tx:'0xabc',logIndex:2,contract:'0xdef',requestId:'3',receiptId:'0xabc:0x4',reason:'Ambiguous, "not counted"'}];$('csv').onclick();`,ctx);
// RFC 4180 quoted fields: quotes are doubled, never backslash-escaped.
const [header,row]=ctx.exported.trimEnd().split('\n');
assert.equal(header.split(',').length,22);
assert.equal(header.split(',')[8],'receipt_or_claim_id');
assert.equal(header.split(',')[9],'reason');
assert(row.includes(',"Ambiguous, ""not counted""",'));
assert(row.includes('"UNKNOWN","UNKNOWN"'));
assert(row.includes('"0xabc:0x4"'));
console.log('PASS: CSV evidence export has matching headers, receipt identity and RFC 4180 quoting');
