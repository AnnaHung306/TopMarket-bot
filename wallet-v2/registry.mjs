import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { boxes, MARKET, STAKE } from '../worker/index.js';
import { RAFFLE_CONTRACT } from '../worker/history/raffle.js';
import { getFilteredLogs } from '../worker/history/chain.js';
import { address, asAddress, hex } from './model.mjs';

export const IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const contractsDir = new URL('./contracts/', import.meta.url);
export async function upgradeDefinition() {
  const manifest = JSON.parse(await readFile(new URL('card-upgrade.manifest.json', contractsDir), 'utf8'));
  const abi = JSON.parse(await readFile(new URL(manifest.abiFile, contractsDir), 'utf8'));
  const source = await readFile(new URL('CardUpgrade.sol', contractsDir));
  if (createHash('sha256').update(source).digest('hex') !== manifest.sourceSha256) throw Error('Verified upgrade source hash mismatch');
  return { ...manifest, abi, topics: Object.fromEntries(manifest.events.map(e => [e.signature.split('(')[0], e.signatureHash32])),
    selectors: Object.fromEntries(manifest.functions.map(f => [f.signature.split('(')[0], f.signatureHash4])) };
}
export async function officialJson(path, { fetchImpl = fetch, signal } = {}) {
  const response = await fetchImpl(new URL(path, 'https://api.top.market/api/'), {
    headers: { accept: 'application/json' }, signal: signal || AbortSignal.timeout(20000),
  });
  if (!response.ok) throw Error(`官方活動資料 HTTP ${response.status}`);
  return response.json();
}
async function officialPages(path, options) {
  const list = []; let page = 1;
  for (;;) {
    const data = await officialJson(`${path}${path.includes('?') ? '&' : '?'}page=${page}&page_size=100`, options);
    if (!Array.isArray(data.list)) throw Error('官方活動清單格式變更');
    list.push(...data.list);
    if (list.length >= Number(data.total ?? list.length)) return list;
    if (!data.list.length) throw Error('官方活動清單不完整');
    page++;
  }
}
export async function loadCatalog(reader, head, options = {}) {
  const [registered, packs, upgradePools, definition] = await Promise.all([
    boxes(hex(head), reader.batch), officialPages('packs', options), officialPages('card-upgrades/pools', options), upgradeDefinition(),
  ]);
  const names = new Map(packs.map(p => [address(p.pool_address), p]));
  const cards = {};
  for (const pool of packs) for (const card of pool.collections || []) {
    if (card.contract_address) cards[address(card.contract_address)] = { name: card.card_name, number: card.number };
  }
  const catalog = registered.map(pool => ({ id: `pack:${pool.address}`, kind: 'packs', address: address(pool.address),
    name: names.get(pool.address)?.name || `鏈上卡池 ${pool.address.slice(0, 10)}`,
    nameVerified: names.has(pool.address), enabled: names.get(pool.address)?.status === 'active', source: 'factory', packKind: pool.type }));
  catalog.push({ id: 'market', kind: 'market', address: MARKET, name: 'Top.Market 市場' },
    { id: 'staking', kind: 'staking', address: STAKE, name: '質押與留卡結算' },
    { id: 'raffle', kind: 'raffle', address: RAFFLE_CONTRACT, name: '奪寶' });
  for (const pool of upgradePools) {
    const supported = address(pool.address) === definition.address && Number(pool.start_block) === definition.startBlock;
    catalog.push({ id: `upgrade:${pool.id}`, kind: 'upgrade', address: address(pool.address), name: pool.name,
      startBlock: Number(pool.start_block), enabled: pool.enabled, supported,
      ...(supported ? { definition } : { unsupportedReason: '新活動池尚未核實合約版本與事件規則' }) });
  }
  return { pools: catalog, cards, unsupported: catalog.filter(p => p.supported === false) };
}
export async function verifyUpgradeVersion(reader, pool, from, through) {
  const definition = pool.definition;
  if (!definition) throw Error('Upgrade adapter is not verified');
  const start = Math.max(from, pool.startBlock);
  if (start > through) return;
  const [before, after, changes] = await Promise.all([
    reader.rpc('eth_getStorageAt', [pool.address, IMPLEMENTATION_SLOT, hex(start)]),
    reader.rpc('eth_getStorageAt', [pool.address, IMPLEMENTATION_SLOT, hex(through)]),
    getFilteredLogs(reader, { address: pool.address, topics: [definition.topics.Upgraded] }, start, through),
  ]);
  const implementations = [asAddress(before), asAddress(after), ...changes.map(l => asAddress(l.topics[1]))];
  if (implementations.some(implementation => implementation !== definition.implementation)) {
    throw Error('活動合約在此期間使用尚未核實的 implementation；未把該活動列為零收益');
  }
}
