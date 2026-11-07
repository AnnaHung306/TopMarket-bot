import { addr, SIG, USDC } from '../index.js';

const sender = '0xb7ef47bf545c62337ca239f202ca88cf05d14065';
export const auditedCampaignWallet = '0x5ac570565f4037d76708f3d95066763021f43e58';

// Finalized Base transfers reviewed against Top.Market's campaign batches.
// A transfer without an itemized allocation remains other campaign income.
// Recipient, block, transaction hash and log index identify each source.
const rows = [
  ['0xc067c97472b5d29ceb73ecab59e7b10a5975d00f', 53154805, '0x420f59a557a211a406ef2a6f20f3d09ee9bca8e3fd8d5f89f039f57518ddec35:0x38e',
    { compensationRaw: '46100000', reason: 'Week 1 Genesis Pack compensation' }],
  ['0x8919ddc803c00ba043e92838585f166d8e54c116', 53154806, '0x93d855cfe18235c25f7dca1a6231a96b03c9c3a96670ab71822ad32c659deb74:0xc4',
    { compensationRaw: '95100000', reason: 'Week 1 Genesis Pack compensation' }],
  ['0x8e49d9feb2fef1eb043965bb45fb8fc941f936a1', 53154811, '0x2ff2a2350c0054d89eb2d17eed98266914574894f4c4097da7e5c201a756e37d:0x50',
    { otherRaw: '62000000', reason: 'Week 1 Lucky Airdrop batch' }],
  ['0xd25c5d138579da67eb884fdc2cb9e81d581b71c1', 53154816, '0x9196a1aa37c22ab88d8c8e600ca8e13f18a06449cfe36b848e6eb9ee394fc84b:0x75',
    { otherRaw: '18600000', reason: 'Week 1 Lucky Airdrop batch' }],
  ['0xd0983ef1dfbc0d413da6f458ae1524767627967b', 53154816, '0x06adafc6ffd204f28c58ee8eecfc20748be61bbb2df654743e6863bec3aa408e:0x258',
    { otherRaw: '27100000', reason: 'Week 1 Lucky Airdrop batch' }],
  ['0xe618f35dfbf4ab79b02b315fd60c69cd289ef75d', 53154822, '0x3c608d4533c3df621b53b1bdab942eeb17a63d8c054c4fd6ee9a1b864c7bdab7:0x5f',
    { otherRaw: '2800000', reason: 'Week 1 Lucky Airdrop batch' }],
  ['0xc067c97472b5d29ceb73ecab59e7b10a5975d00f', 53268061, '0x40d2a02dc2ef953ee507d53c462d5c451e4a81195778a6c06cd6d230c9a89f87:0xe6',
    { prizeRaw: '100000000', reason: 'Week 1 leaderboard prize' }],
  ['0x8919ddc803c00ba043e92838585f166d8e54c116', 53268061, '0x3ffd1804d1bb7e8eda46efd60ce3f817efd28a7d44f436977b7ac7949aef91b2:0x25b',
    { prizeRaw: '50000000', reason: 'Week 1 leaderboard prize' }],
  ['0x8e49d9feb2fef1eb043965bb45fb8fc941f936a1', 53268066, '0xe41957737d97a1d8c901924611a0b18e20940dd35ab8c27650576e61eaedd952:0x5f',
    { prizeRaw: '20000000', reason: 'Week 1 leaderboard prize' }],
  ['0xd0983ef1dfbc0d413da6f458ae1524767627967b', 53268066, '0xdc8ef68a54b213b6e9f17e3bbf147921b73277c100af6f5c2d071676da999f22:0x141',
    { otherRaw: '517000000', reason: 'Week 1 leaderboard payout batch' }],
  ['0xe618f35dfbf4ab79b02b315fd60c69cd289ef75d', 53268066, '0xd411cfff910da99e566ca7a7e0f4a39b3f39a94e560ee245825eef8e27b46721:0x21e',
    { prizeRaw: '20000000', reason: 'Week 1 leaderboard prize' }],
  ['0x705d774eefbaf22555933cf3e08247d1f28fd000', 53268071, '0xbfcc345af97057d6f99758472a8e3df619eabad4ecac241a906b4670d6ea2c97:0x1a1',
    { prizeRaw: '20000000', reason: 'Week 1 leaderboard prize' }],
  ['0xd25c5d138579da67eb884fdc2cb9e81d581b71c1', 53268071, '0xa3ba7697e5b4bacd7ff156ebc8efa746c1d0c451d4f4268724e8405bba97e217:0x3eb',
    { prizeRaw: '20000000', reason: 'Week 1 leaderboard prize' }],
  ['0x5ac570565f4037d76708f3d95066763021f43e58', 53268076, '0x0167d623c3fa84bba3740b8e59296d4ae42562afb06ba2818a434ab2ba14a3f0:0xcc',
    { prizeRaw: '15000000', reason: 'Week 1 lucky draw' }],
  ['0x7accaaa1c824ec76228282a3a5380a863399523c', 53268076, '0x75fb9354c6a25ad9daa4657ac12b27a712dbb2922e91106d95cdbc4f6a594c9d:0x17d',
    { prizeRaw: '15000000', reason: 'Week 1 lucky draw' }],
  ['0x8919ddc803c00ba043e92838585f166d8e54c116', 53530379, '0xf7fba1a5967648137e8a7698ed5f5de446fb465cd974819300bb7c7164e48582:0xe5',
    { compensationRaw: '161800000', prizeRaw: '6000000', reason: 'Week 2 Genesis Pack compensation and staker airdrop' }],
  ['0x2aa4a76953fdaa33aa86fd2629fc3eeb51127fc4', 53530379, '0x85cc21bf51e5675a39f8adf7cf0cafaf38cced79346590cc701bb41241f07f38:0x558',
    { otherRaw: '113200000', reason: 'Week 2 airdrop batch' }],
  ['0x7accaaa1c824ec76228282a3a5380a863399523c', 53530389, '0x11d1c02f561b2935465c19997ef1ae46e186d1fc2086ed3663802883d80a59e4:0x16e',
    { compensationRaw: '14800000', prizeRaw: '61000000', reason: 'Week 2 Genesis Pack compensation and staker airdrop' }],
  ['0xc067c97472b5d29ceb73ecab59e7b10a5975d00f', 53530390, '0x8d292c4a0bc629481c78beeec3d189ed53acc1f32d82147a95cdb504bad53083:0x324',
    { compensationRaw: '55100000', prizeRaw: '5500000', reason: 'Week 2 Genesis Pack compensation and staker airdrop' }],
  ['0x5ac570565f4037d76708f3d95066763021f43e58', 53530400, '0xbb9ac4f14bee2b9158ecae70735ab7ae099e8a232766b43377232d4aed7aaba6:0x2d7',
    { compensationRaw: '44400000', prizeRaw: '700000', reason: 'Week 2 Genesis Pack compensation and staking airdrop' }],
  ['0xe618f35dfbf4ab79b02b315fd60c69cd289ef75d', 53530401, '0x3562f8c7687d869a641bbed3c8f0e0bf62a3c1bdcd829886bd1ef447f4dc296e:0x131',
    { prizeRaw: '38000000', reason: 'Week 2 staker airdrop' }],
  ['0xd0983ef1dfbc0d413da6f458ae1524767627967b', 53530412, '0xf4b4b05901850feec4cbc5e361745b5fb0f0b2940910b53405455f9c502fa75f:0x16a',
    { compensationRaw: '18300000', prizeRaw: '3000000', reason: 'Week 2 Genesis Pack compensation and staker airdrop' }],
  ['0x8e49d9feb2fef1eb043965bb45fb8fc941f936a1', 53530847, '0xf47a40e446fe267e126744ccc06e98e001d18672584074eb84de99e70464fed9:0x32',
    { prizeRaw: '800000', reason: 'Week 2 staker airdrop' }],
  ['0x705d774eefbaf22555933cf3e08247d1f28fd000', 53531064, '0xddb1595816fe8389eb3b17ecc5af8780bd7dc608093e323763b9b851c1cf1506:0x272',
    { prizeRaw: '500000', reason: 'Week 2 staker airdrop' }],
  ['0xd25c5d138579da67eb884fdc2cb9e81d581b71c1', 53531198, '0x12f3506f4922329977218a9aa8ba9aa332daf24dc0dfad64d9b6e57e0856e807:0x1fb',
    { prizeRaw: '500000', reason: 'Week 2 staker airdrop' }],
  ['0xe618f35dfbf4ab79b02b315fd60c69cd289ef75d', 53550004, '0x1841d88fac47f5218e07fee8d8db9b127fca4cd7c7ba455b408e6f02b15d4573:0xcf',
    { prizeRaw: '150000000', reason: 'Week 2 leaderboard prize' }],
  ['0x5ac570565f4037d76708f3d95066763021f43e58', 53550004, '0x189aa5ddc789bd89bcf7378bd049fa7fec5c978445603c24a801c4a9d40ff7fa:0x30f',
    { prizeRaw: '100000000', reason: 'Week 2 leaderboard prize' }],
  ['0x7accaaa1c824ec76228282a3a5380a863399523c', 53550004, '0x7219e695ba71ee9d7e69281208df69abcea767a23a13aeeda9b4754efc94bc78:0x45f',
    { prizeRaw: '50000000', reason: 'Week 2 leaderboard prize' }],
  ['0x8919ddc803c00ba043e92838585f166d8e54c116', 53550011, '0x0b84ca427a9ac54aeb3ab0b7dfbba844460eb4ea4f1addbf09ad0ea86f4dbaa5:0x4b0',
    { prizeRaw: '20000000', reason: 'Week 2 leaderboard prize' }],
  ['0xd0983ef1dfbc0d413da6f458ae1524767627967b', 53550012, '0x9c2853c6746cc51e6b612d106fd3d30cc36796ce8cbc24dfe7041e564dcee398:0x117',
    { prizeRaw: '20000000', reason: 'Week 2 leaderboard prize' }],
  ['0x2aa4a76953fdaa33aa86fd2629fc3eeb51127fc4', 53550012, '0x2dc205582df82c976fb80b74c4872518858524cd5764945b070378b16f474ac8:0x433',
    { prizeRaw: '20000000', reason: 'Week 2 leaderboard prize' }],
  ['0x705d774eefbaf22555933cf3e08247d1f28fd000', 53550019, '0x7b95028df6406b702e733f3b6db565c962170af530682e4dd14f4b90a602607c:0x131',
    { prizeRaw: '20000000', reason: 'Week 2 leaderboard prize' }],
  ['0xc067c97472b5d29ceb73ecab59e7b10a5975d00f', 53550019, '0xf89a33372064ad872afcfeb92f9dd5581382fbcad0d810376dbd1388d36fa3a6:0x4de',
    { prizeRaw: '20000000', reason: 'Week 2 leaderboard prize' }],
  ['0x8e49d9feb2fef1eb043965bb45fb8fc941f936a1', 53550019, '0x1a0a5f608d117cbe8ca17c0538c6b357bdfef5da166b134477b2e9f2a3028911:0x6f1',
    { prizeRaw: '20000000', reason: 'Week 2 leaderboard prize' }],
  ['0xd25c5d138579da67eb884fdc2cb9e81d581b71c1', 53550027, '0x98f7b01277328d86b566b6922da19a95ca02164181f4335c6c8bed1465918f4d:0x209',
    { prizeRaw: '20000000', reason: 'Week 2 leaderboard prize' }],
];

const payoutById = new Map(rows.map(([wallet, block, id, allocation]) => [id, { wallet, block, id, allocation }]));

function payoutEvent({ id, block, allocation }) {
  const { compensationRaw = '0', prizeRaw = '0', otherRaw = '0', reason } = allocation;
  const raw = BigInt(compensationRaw) + BigInt(prizeRaw) + BigInt(otherRaw);
  const [tx, logIndex] = id.split(':');
  return { id, tx, block, logIndex: Number(logIndex), contract: USDC, payer: sender,
    category: 'campaign-payout', raw: raw.toString(), amount: Number(raw) / 1e6,
    compensationRaw, prizeRaw, otherRaw, reason };
}

export function campaignPayoutEvents(wallet, cash) {
  const events = [];
  for (const log of cash) {
    if (log.address !== USDC || log.topics[0] !== SIG.transfer || log.topics.length !== 3) continue;
    const payout = payoutById.get(log.transactionHash + ':' + log.logIndex);
    if (!payout || payout.wallet !== wallet || payout.block !== Number(log.blockNumber)) continue;
    if (addr(log.topics[1]) !== sender || addr(log.topics[2]) !== wallet) continue;
    const event = payoutEvent(payout);
    if (BigInt(log.data) === BigInt(event.raw)) events.push(event);
  }
  return events;
}

export function campaignPayoutsInRange(wallet, from, through) {
  return [...payoutById.values()]
    .filter(payout => payout.wallet === wallet && payout.block >= from && payout.block <= through)
    .map(payoutEvent);
}
