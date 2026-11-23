import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { getFilteredLogs } from '../worker/history/chain.js';
import { asAddress, hex, word, words } from './model.mjs';

const UPGRADED = '0xbc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b';
export function acquisitionIndex(events) {
  const requests = new Map(), wins = new Map();
  const add = (map, key, event) => { if (!map.has(key)) map.set(key, []); map.get(key).push(event); };
  for (const event of events) {
    if (event.requestId !== undefined) add(requests, `${event.contract}:${event.requestId}`, event);
    if (event.winId !== undefined) add(wins, `${event.contract}:${event.winId}`, event);
  }
  return { requests, wins };
}
export function uniqueDrawForWin(events, win, index = acquisitionIndex(events)) {
  const group = index.requests.get(`${win.contract}:${win.requestId}`) || [];
  const draws = group.filter(event => event.category === 'pack');
  const wins = group.filter(event => event.category === 'won');
  if (draws.length !== 1 || wins.length !== 1 || draws[0].block > win.block || !draws[0].paymentVerified) return null;
  if (group.some(event => /^(?:refund|rescue)/.test(event.category))) return null;
  const draw = draws[0];
  const proof = draw.adapterEvidence;
  return draw.sourceStatus === 'legacy-receipt' || proof?.verified && proof.winId === win.winId &&
    proof.source === draw.randomnessSource && proof.drawEventId === (draw.v2Id || draw.id) && proof.winEventId === (win.v2Id || win.id) ? draw : null;
}
export async function verifyAdapterAcquisitions(reader, ledger, onProgress, saveProgress) {
  if (!ledger.coverage.gavin?.complete) return;
  const manifest = JSON.parse(await readFile(new URL('./contracts/blind-box-acquisition.manifest.json', import.meta.url), 'utf8'));
  const source = await readFile(new URL('./contracts/BlindBox.sol', import.meta.url));
  if (createHash('sha256').update(source).digest('hex') !== manifest.sourceSha256) throw Error('Verified BlindBox source hash mismatch');
  const pending = ledger.events.filter(event => event.category === 'pack' && event.packKind === 'card' && event.paymentVerified &&
    event.sourceStatus === 'adapter-source-unresolved' && event.adapterEvidence?.version !== manifest.proofVersion);
  if (!pending.length) return;
  const index = acquisitionIndex(ledger.events), candidates = [];
  for (const draw of pending) {
    const evidence = { verified: false, source: draw.randomnessSource,
      reason: '尚未核實來源命名空間或唯一結算' };
    draw.adapterEvidence = evidence;
    const group = index.requests.get(`${draw.contract}:${draw.requestId}`) || [];
    const draws = group.filter(event => event.category === 'pack'), wins = group.filter(event => event.category === 'won');
    if (draws.length !== 1 || wins.length !== 1 || !draw.randomnessSource || wins[0].block <= draw.block ||
      group.some(event => /^(?:refund|rescue)/.test(event.category))) { evidence.version = manifest.proofVersion; continue; }
    candidates.push({ draw, win: wins[0], evidence });
  }
  // A block-specific call is identical across requests: deduplicate its transport,
  // while retaining the original historical checks for each individual draw.
  async function readPhase(name, rows, callsFor) {
    const calls = new Map();
    for (const row of rows) for (const call of callsFor(row)) calls.set(JSON.stringify(call), call);
    const entries = [...calls.entries()];
    for (let offset = 0; offset < entries.length; offset += 100) {
      const chunk = entries.slice(offset, offset + 100);
      const results = await reader.batch(chunk.map(([, call]) => call));
      chunk.forEach(([key], i) => calls.set(key, results[i]));
      await onProgress?.({ phase: name, completed: Math.min(offset + 100, entries.length), total: entries.length });
    }
    return call => calls.get(JSON.stringify(call));
  }
  const storageCalls = row => [row.draw.block, row.win.block].map(block =>
    ['eth_getStorageAt', [row.draw.contract, manifest.beaconSlot, hex(block)]]);
  const storage = await readPhase('historical-beacon', candidates, storageCalls);
  const sameBeacon = candidates.filter(row => {
    const slots = storageCalls(row).map(storage);
    if (slots[0] !== slots[1] || /^0x0+$/.test(slots[0])) { Object.assign(row.evidence, { version: manifest.proofVersion, reason: '抽卡與結算的 beacon 不一致' }); return false; }
    row.beacon = asAddress(slots[0]); return true;
  });
  const implementationCalls = row => [row.draw.block, row.win.block].map(block =>
    ['eth_call', [{ to: row.beacon, data: '0x5c60da1b' }, hex(block)]]);
  const implementations = await readPhase('historical-implementation', sameBeacon, implementationCalls);
  const verifiedImplementation = sameBeacon.filter(row => {
    if (implementationCalls(row).map(implementations).some(value => asAddress(value) !== manifest.implementation)) {
      Object.assign(row.evidence, { version: manifest.proofVersion, reason: '此歷史 BlindBox implementation 尚未核實' }); return false;
    }
    return true;
  });
  const timelines = new Map();
  for (const row of verifiedImplementation) {
    const range = timelines.get(row.beacon) || { from: row.draw.block, to: row.win.block };
    range.from = Math.min(range.from, row.draw.block); range.to = Math.max(range.to, row.win.block);
    timelines.set(row.beacon, range);
  }
  for (const [beacon, range] of timelines) range.logs = await getFilteredLogs(reader, { address: beacon, topics: [UPGRADED] }, range.from, range.to);
  const stable = verifiedImplementation.filter(row => {
    if (timelines.get(row.beacon).logs.some(log => Number(log.blockNumber) >= row.draw.block && Number(log.blockNumber) <= row.win.block &&
      asAddress(log.topics[1]) !== manifest.implementation)) { Object.assign(row.evidence, { version: manifest.proofVersion, reason: '結算期間存在其他 implementation' }); return false; }
    return true;
  });
  const sourceCalls = row => {
    const call = manifest.selector + word(row.draw.randomnessSource).slice(2) + BigInt(row.draw.requestId).toString(16).padStart(64, '0');
    return [row.draw.block, row.win.block - 1, row.win.block].map(block => ['eth_call', [{ to: row.draw.contract, data: call }, hex(block)]]);
  };
  for (let offset = 0; offset < stable.length; offset += 200) {
    const group = stable.slice(offset, offset + 200);
    const sourceStates = await readPhase('namespaced-acquisition', group, sourceCalls);
    for (const { draw, win, evidence, beacon } of group) {
      evidence.version = manifest.proofVersion;
      const responses = sourceCalls({ draw, win }).map(sourceStates);
      const state = responses.map(value => words(value));
      const matches = row => row.length === 3 && asAddress(row[0]) === ledger.wallet && BigInt('0x' + row[1]).toString() === draw.paidRaw &&
        Number(BigInt('0x' + row[2])) === draw.timestamp;
      const cleared = state[2].length === 3 && state[2].every(value => BigInt('0x' + value) === 0n);
      if (!matches(state[0]) || !matches(state[1]) || !cleared) { evidence.reason = '來源請求的玩家、淨付款、時間或清除時序無法唯一核對'; continue; }
      Object.assign(evidence, { verified: true, beacon, implementation: manifest.implementation, winId: win.winId,
        drawEventId: draw.id, winEventId: win.id, blocks: [draw.block, win.block - 1, win.block], responses,
        reason: '已核實同來源請求在申請後／結算前屬於此玩家，並於唯一結算清除；付款另由 Gavin 回執證明' });
    }
    await saveProgress?.();
    await onProgress?.({ phase: 'saved-acquisition', completed: Math.min(offset + 200, stable.length), total: stable.length });
  }
}
