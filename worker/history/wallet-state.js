import { addr, hex, SIG } from '../index.js';
import { callKey, getFilteredLogs } from './chain.js';
import { readHistoricalCalls } from './multicall.js';

const BEACON_SLOT = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50';
const UPGRADED = '0xbc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b';
const TREASURY = '0x61d027b3';
const stateGetters = new Set([TREASURY, '0x7b9e618d', '0x46904840']);
const auditedBeacons = new Map([
  ['0x7f9b6abff3eab34cc1f3e723798e54d67977a4a7', new Set([
    '0x10d96bca93c1bf3da5770b31a6ca052f92830e4c',
    '0x2d77d7a18883072dc14ebef1d62827b51819bafa',
    '0x5a209fad25b9300e6e9abe84d58dc13e9b1151e6',
    '0x4267a71b93aed76064e3b292eb6763a172b76ed9',
    '0x7a17fc80510db62a7d8c7ebf8fc1d5aff00e8c5f',
    '0x474b9863033a34918c72fc711f72470372bc0cbb',
    '0xfb48996d18e4a0fe11d82f7f47fcacc835772994',
    '0x8e09eaeee3e0287e9ad9b56f6cb75afa47293d42',
  ])],
  ['0x9cac2ee1ae5ebef1b3a180404ea2d0951c7b416e', new Set([
    '0x2f2c7fbc60655c1a84ad04bdb0c95c6be6451421',
    '0x60cd098b6ae76591c6391add2d3cbca21fb65f34',
    '0xfbc4e0fd5a37f42911803ae1ccc7cf404bdaa599',
  ])],
]);
const ordered = (a, b) => Number(a.blockNumber) - Number(b.blockNumber) || Number(a.logIndex) - Number(b.logIndex);
const addressWord = value => typeof value === 'string' && /^0x0{24}[0-9a-f]{40}$/i.test(value) && BigInt(value) !== 0n ? addr(value) : null;

export async function walletStateHistory(reader, addresses, from, to) {
  const at = hex(to);
  const trusted = [...auditedBeacons.keys()];
  const [slots, current, updates, upgrades, implementations] = await Promise.all([
    reader.batch(addresses.map(box => ['eth_getStorageAt', [box, BEACON_SLOT, at]])),
    reader.batch(addresses.map(to => ['eth_call', [{ to, data: TREASURY }, at]]), true),
    addresses.length ? getFilteredLogs(reader, { address: addresses, topics: [[SIG.treasuryUpdated, SIG.feeRecipientUpdated]] }, from, to) : [],
    getFilteredLogs(reader, { address: trusted, topics: [UPGRADED] }, from, to),
    reader.batch(trusted.map(to => ['eth_call', [{ to, data: '0x5c60da1b' }, at]]), true),
  ]);
  const beacons = new Map(addresses.map((box, index) => [box, addressWord(slots[index])]));
  const timelines = new Map(trusted.map((beacon, index) => {
    const versions = upgrades.filter(log => log.address === beacon).sort(ordered);
    const last = addressWord(versions.at(-1)?.topics[1]);
    return [beacon, last && last === addressWord(implementations[index]) ? versions : []];
  }));
  const configs = new Map(addresses.map(box => [box, updates.filter(log => log.address === box).sort(ordered)]));
  const treasuryChanges = [...configs.values()].map(logs => logs.filter(log => log.topics[0] === SIG.treasuryUpdated));
  // The first update only announces the new payer. Read the preceding payer as well.
  const initial = await reader.batch(treasuryChanges.flatMap(logs => logs.length ? [
    ['eth_call', [{ to: logs[0].address, data: TREASURY }, hex(Number(logs[0].blockNumber) - 1)]],
  ] : []), true);
  const payers = new Set([...current, ...initial, ...treasuryChanges.flat().map(log => log.topics[1])].map(addressWord).filter(Boolean));

  function epoch(box, block) {
    const beacon = beacons.get(box);
    const version = timelines.get(beacon)?.findLast(log => Number(log.blockNumber) <= block);
    if (!version || !auditedBeacons.get(beacon).has(addressWord(version.topics[1]))) return null;
    const update = configs.get(box).findLast(log => Number(log.blockNumber) <= block);
    return Math.max(Number(version.blockNumber), Number(update?.blockNumber ?? 0));
  }

  function audited(block) {
    return addresses.every(box => {
      const versions = timelines.get(beacons.get(box));
      // UpgradeableBeacon emits Upgraded on construction, before any box uses it.
      if (versions?.length && block < Number(versions[0].blockNumber)) return true;
      const start = epoch(box, block);
      return start !== null && start < block;
    });
  }
  return { updates, payers, epoch, audited };
}

export async function readWalletHistoricalCalls(reader, calls, history) {
  const anchors = new Map();
  const keys = calls.map((call, index) => {
    const [, [target, at]] = call;
    const epoch = stateGetters.has(target.data) ? history.epoch(target.to, Number(at)) : null;
    const key = epoch === null ? callKey(call[1]) : `${target.to}:${epoch}:${target.data}`;
    if (!anchors.has(key) || Number(calls[anchors.get(key)][1][1]) > Number(at)) anchors.set(key, index);
    return key;
  });
  const values = new Map([...anchors.keys()].map((key, index) => [key, index]));
  const fetched = await readHistoricalCalls(reader, [...anchors.values()].map(index => calls[index]));
  const results = keys.map(key => fetched[values.get(key)]);
  // The earliest requested block can precede deployment. Preserve exact reads
  // for the remaining blocks in an interval when the anchor has no state.
  const missing = calls.flatMap((call, index) => !addressWord(results[index]) && anchors.get(keys[index]) !== index ? [index] : []);
  const exact = await readHistoricalCalls(reader, missing.map(index => calls[index]));
  missing.forEach((index, i) => { results[index] = exact[i]; });
  return results;
}
