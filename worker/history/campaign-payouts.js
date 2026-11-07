import { addr, SIG, USDC } from '../index.js';

const sender = '0xb7ef47bf545c62337ca239f202ca88cf05d14065';
export const auditedCampaignWallet = '0x5ac570565f4037d76708f3d95066763021f43e58';

// Week 1 lucky draw, Week 2 airdrops, and Week 2 leaderboard prize.
// The 45.10 transfer's split follows the published rules and the audited card activity.
const payouts = new Map([
  ['0x0167d623c3fa84bba3740b8e59296d4ae42562afb06ba2818a434ab2ba14a3f0:0xcc',
    { compensationRaw: '0', prizeRaw: '15000000', reason: 'Week 1 lucky draw' }],
  ['0xbb9ac4f14bee2b9158ecae70735ab7ae099e8a232766b43377232d4aed7aaba6:0x2d7',
    { compensationRaw: '44400000', prizeRaw: '700000', reason: 'Week 2 Genesis Pack compensation and staking airdrop' }],
  ['0x189aa5ddc789bd89bcf7378bd049fa7fec5c978445603c24a801c4a9d40ff7fa:0x30f',
    { compensationRaw: '0', prizeRaw: '100000000', reason: 'Week 2 leaderboard prize' }],
]);

export function campaignPayoutEvents(wallet, cash) {
  if (wallet !== auditedCampaignWallet) return [];
  const events = [];
  for (const log of cash) {
    const id = `${log.transactionHash}:${log.logIndex}`;
    const payout = payouts.get(id);
    if (!payout || log.address !== USDC || log.topics[0] !== SIG.transfer || log.topics.length !== 3) continue;
    if (addr(log.topics[1]) !== sender || addr(log.topics[2]) !== wallet) continue;
    const amount = BigInt(log.data);
    if (amount !== BigInt(payout.compensationRaw) + BigInt(payout.prizeRaw)) continue;
    events.push({ ...payout, id, tx: log.transactionHash, block: Number(log.blockNumber), logIndex: Number(log.logIndex),
      contract: USDC, payer: sender, category: 'campaign-payout', raw: amount.toString(), amount: Number(amount) / 1e6 });
  }
  return events;
}
