import { getFilteredLogs } from '../worker/history/chain.js';
import { verifyUpgradeVersion } from './registry.mjs';
import { address, asAddress, eventId, hex, word, words, TRANSFER, USDC } from './model.mjs';
import { verifyUpgradeRecycles } from './upgrade-recycle.mjs';

export function decodeUpgradeLog(log, pool) {
  if (address(log.address) !== pool.address || log.removed) throw Error('Invalid upgrade event source');
  const definition = pool.definition;
  const name = Object.entries(definition.topics).find(([, hash]) => hash === log.topics[0])?.[0];
  if (!['UpgradeRequested', 'UpgradeSettled', 'UpgradeRescued', 'CardClaimable', 'CardClaimed', 'ChoicePending', 'WinKept', 'WinRecycled'].includes(name)) return null;
  if (log.topics.length < 2) throw Error('Missing spin ID');
  const values = words(log.data), uint = i => BigInt('0x' + values[i]).toString();
  const event = { id: eventId(log.transactionHash, log.logIndex), tx: log.transactionHash.toLowerCase(),
    block: Number(log.blockNumber), logIndex: Number(log.logIndex), contract: pool.address, activity: 'upgrade',
    poolId: pool.id, category: name, spinId: BigInt(log.topics[1]).toString(), raw: null, rawLog: log };
  if (name === 'UpgradeRequested') {
    if (values.length !== 10 || log.topics.length !== 3) throw Error('Upgrade request ABI mismatch');
    Object.assign(event, { player: asAddress(log.topics[2]), source: asAddress(values[0]), requestId: uint(1),
      stakeCollection: asAddress(values[2]), stakeTokenId: uint(3), stakeValueRaw: uint(4),
      targetCollection: asAddress(values[5]), targetTokenId: uint(6), targetValueRaw: uint(7),
      edgeBps: Number(uint(8)), chanceBps: Number(uint(9)) });
    if (event.edgeBps > 10000 || event.chanceBps > 10000) throw Error('Invalid upgrade probability');
    if (BigInt(event.stakeValueRaw) <= 0n || BigInt(event.targetValueRaw) <= BigInt(event.stakeValueRaw)) throw Error('Invalid upgrade reference values');
  } else if (name === 'UpgradeSettled') {
    if (values.length !== 2 || log.topics.length !== 2 || !['0', '1'].includes(uint(0))) throw Error('Upgrade settlement ABI mismatch');
    Object.assign(event, { won: uint(0) === '1', randomWord: uint(1) });
  } else if (name === 'ChoicePending') {
    if (values.length !== 2 || log.topics.length !== 3) throw Error('Upgrade choice ABI mismatch');
    Object.assign(event, { player: asAddress(log.topics[2]), deadline: Number(uint(0)), recycleRaw: uint(1) });
  } else if (name === 'WinRecycled') {
    if (values.length !== 1 || log.topics.length !== 3) throw Error('Upgrade recycle ABI mismatch');
    Object.assign(event, { player: asAddress(log.topics[2]), recycleRaw: uint(0) });
  } else if (['CardClaimable', 'CardClaimed'].includes(name)) {
    if (values.length !== 2 || log.topics.length !== 3) throw Error('Upgrade delivery ABI mismatch');
    Object.assign(event, { player: asAddress(log.topics[2]), collection: asAddress(values[0]), tokenId: uint(1) });
  } else {
    if (values.length || log.topics.length !== 3) throw Error('Upgrade rescue/keep ABI mismatch');
    event.player = asAddress(log.topics[2]);
  }
  return event;
}

export async function scanUpgrades(reader, wallet, pool, from, through, existingEvents = []) {
  const start = Math.max(from, pool.startBlock);
  if (start > through) return { from: start, to: through, events: [] };
  await verifyUpgradeVersion(reader, pool, start, through);
  const definition = pool.definition;
  const requests = (await getFilteredLogs(reader, { address: pool.address,
    topics: [definition.topics.UpgradeRequested, null, word(wallet)] }, start, through)).map(log => decodeUpgradeLog(log, pool));
  const ids = [...new Set([...existingEvents, ...requests].filter(e => e.category === 'UpgradeRequested' && e.poolId === pool.id).map(e => e.spinId))];
  const outcomeStart = Math.max(start, Math.min(...[...existingEvents, ...requests]
    .filter(e => e.category === 'UpgradeRequested' && e.poolId === pool.id).map(e => e.block)));
  const results = [];
  for (let i = 0; i < ids.length; i += 100) {
    results.push(...await getFilteredLogs(reader, { address: pool.address, topics: [[definition.topics.UpgradeSettled,
      definition.topics.UpgradeRescued, definition.topics.CardClaimable, definition.topics.CardClaimed,
      definition.topics.ChoicePending, definition.topics.WinKept, definition.topics.WinRecycled],
    ids.slice(i, i + 100).map(id => '0x' + BigInt(id).toString(16).padStart(64, '0'))] }, outcomeStart, through));
  }
  // The oracle's decimals are read at the request block, not inferred from today's configuration.
  const oracleResults = await reader.batch(requests.map(e => ['eth_call', [{ to: pool.address, data: definition.selectors.oracle }, hex(e.block)]]));
  const decimals = await reader.batch(requests.map((e, index) => ['eth_call', [{ to: asAddress(oracleResults[index]), data: '0x05300b28' }, hex(e.block)]]));
  requests.forEach((event, index) => { event.valueDecimals = Number(BigInt(decimals[index])); });
  const events = [...requests, ...results.map(log => decodeUpgradeLog(log, pool))];
  await verifyUpgradeRecycles(reader, events, pool);
  return { from: start, to: through, events };
}

export function receiptTransfers(receipt, wallet) {
  if (receipt?.status !== '0x1') throw Error('Transaction receipt missing or failed');
  return receipt.logs.filter(log => log.topics[0] === TRANSFER && [3, 4].includes(log.topics.length))
    .map(log => ({ id: eventId(log.transactionHash, log.logIndex), tx: log.transactionHash.toLowerCase(),
      block: Number(log.blockNumber), logIndex: Number(log.logIndex), collection: address(log.address),
      from: asAddress(log.topics[1]), to: asAddress(log.topics[2]),
      ...(log.topics.length === 4 ? { tokenId: BigInt(log.topics[3]).toString(), kind: 'nft' }
        : { raw: BigInt(log.data).toString(), kind: address(log.address) === USDC ? 'usdc' : 'erc20' }),
      walletRelated: [asAddress(log.topics[1]), asAddress(log.topics[2])].includes(wallet) }));
}

export function upgradeSpins(events, transfers, wallet) {
  const related = events.filter(e => e.activity === 'upgrade');
  const spins = [];
  for (const request of related.filter(e => e.category === 'UpgradeRequested' && e.player === wallet)) {
    const group = related.filter(e => e.contract === request.contract && e.spinId === request.spinId);
    if (group.filter(e => e.category === 'UpgradeRequested').length !== 1) throw Error('Duplicate upgrade request identity');
    const settlements = group.filter(e => ['UpgradeSettled', 'UpgradeRescued'].includes(e.category));
    if (settlements.length > 1) throw Error('Conflicting upgrade outcomes');
    const result = settlements[0];
    const claim = group.filter(e => e.category === 'CardClaimed').sort((a, b) => a.block - b.block).at(-1);
    const claimable = group.find(e => e.category === 'CardClaimable');
    const choice = group.find(e => e.category === 'ChoicePending');
    const resolutions = group.filter(e => ['WinKept', 'WinRecycled'].includes(e.category));
    if (resolutions.length > 1 || group.some(e => e.player && e.player !== wallet)) throw Error('Conflicting upgrade winner choice');
    const resolution = resolutions[0];
    const status = !result ? 'pending' : result.category === 'UpgradeRescued' ? 'rescued' : result.won ? 'won' : 'lost';
    if (result?.category === 'UpgradeSettled') {
      const computed = BigInt(result.randomWord) % (BigInt(request.targetValueRaw) * 10000n) <
        BigInt(request.stakeValueRaw) * BigInt(10000 - request.edgeBps);
      if (computed !== result.won) throw Error('Upgrade outcome disagrees with verified contract rule');
    }
    if ((choice || resolution) && status !== 'won') throw Error('Upgrade choice without a winning settlement');
    const returned = status === 'rescued';
    const collection = returned ? request.stakeCollection : request.targetCollection;
    const tokenId = returned ? request.stakeTokenId : request.targetTokenId;
    const deliveryEvent = claim || resolution || result;
    const delivered = deliveryEvent && transfers.filter(t => t.kind === 'nft' && t.tx === deliveryEvent.tx &&
      t.collection === collection && t.tokenId === tokenId && t.from === request.contract && t.to === wallet);
    const stakeProof = transfers.filter(t => t.kind === 'nft' && t.tx === request.tx && t.collection === request.stakeCollection &&
      t.tokenId === request.stakeTokenId && t.from === wallet && t.to === request.contract);
    spins.push({ id: `${request.contract}:${request.spinId}`, poolId: request.poolId, request, result,
      status, delivery: status === 'lost' ? 'none' : resolution?.category === 'WinRecycled'
        ? resolution.recycleVerified ? 'recycled' : 'payout-unverified'
        : delivered?.length === 1 ? 'delivered' : claimable && !claim ? 'claimable' : choice && !resolution ? 'choice-pending' : 'unverified',
      choice, resolution, claim, stakeVerified: stakeProof.length === 1, stakeTransferId: stakeProof.length === 1 ? stakeProof[0].id : null,
      deliveryTransferId: delivered?.length === 1 ? delivered[0].id : null });
  }
  return spins;
}
