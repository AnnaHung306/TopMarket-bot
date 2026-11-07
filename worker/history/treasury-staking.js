import { addr, MARKET, SIG, USDC, word } from '../index.js';

const attributed = new Set(['refund-confirmed', 'buyback-claim-confirmed', 'sales', 'staking-confirmed', 'kept-disposal-confirmed', 'campaign-payout']);
const unresolved = new Set(['refund-pending', 'buyback-claim-pending', 'staking-pending', 'kept-disposal-pending']);

export function treasuryStaking(wallet, cash, events, deferred, isTreasury) {
  const recipient = word(wallet);
  const used = new Set();
  const ambiguous = new Set(deferred.map(log => `${log.transactionHash}:${BigInt(log.data)}`));
  for (const event of events) {
    if (attributed.has(event.category)) used.add(event.id);
    if (unresolved.has(event.category)) ambiguous.add(`${event.tx}:${event.raw}`);
  }

  const groups = new Map();
  for (const log of cash) {
    if (log.address !== USDC || log.topics[0] !== SIG.transfer || log.topics[2] !== recipient) continue;
    const payer = addr(log.topics[1]);
    const block = Number(log.blockNumber);
    const raw = BigInt(log.data);
    if (raw <= 0n || payer === wallet || payer === MARKET || !isTreasury(payer, block)) continue;
    const tx = log.transactionHash;
    const key = `${tx}:${payer}:${raw}`;
    if (!groups.has(key)) groups.set(key, new Map());
    const id = `${tx}:${log.logIndex}`;
    groups.get(key).set(id, { id, tx, payer, block, logIndex: Number(log.logIndex), contract: USDC,
      raw: raw.toString(), amount: Number(raw) / 1e6, category: 'staking-treasury' });
  }

  const staking = [];
  for (const group of groups.values()) {
    if (group.size !== 1) continue;
    const event = group.values().next().value;
    if (!used.has(event.id) && !ambiguous.has(`${event.tx}:${event.raw}`)) staking.push(event);
  }
  return staking;
}
