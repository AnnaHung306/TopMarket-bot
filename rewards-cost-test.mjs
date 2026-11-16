import assert from 'node:assert/strict';
import {decodeReward,reconcileRefunds,verifyDrawPayments,linkAcquisitionCosts,SIG,STAKE} from './worker/index.js';
import {callRecord,evidencePlan} from './worker/history/chain.js';
import {settleRecordedWallet} from './worker/history/report.js';
import {treasuryStaking} from './worker/history/treasury-staking.js';
import {walletEvidence} from './worker/history/wallet-evidence.js';
import {walletStateHistory} from './worker/history/wallet-state.js';
import {auditedCampaignWallet,campaignPayoutEvents} from './worker/history/campaign-payouts.js';
import {raffleEvents,readRaffleLogs} from './worker/history/raffle.js';
import {addWalletTotals, displayWalletTotals, summarizeWalletEvents} from './worker/report/accounting.js';
import { walletCachePage } from './worker/wallet-cache.js';
import { directWalletReport, directWalletReportBatch } from './worker/wallet-direct.js';
const wallet='0x'+'1'.repeat(40),box='0x'+'2'.repeat(40),treasury='0x'+'3'.repeat(40),other='0x'+'4'.repeat(40),nft='0x'+'5'.repeat(40),usdc='0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',tx='0x'+'a'.repeat(64);
const w=n=>BigInt(n).toString(16).padStart(64,'0'),a=s=>'0x'+s.slice(2).padStart(64,'0');
const base={address:box,transactionHash:tx,logIndex:'0x1',blockNumber:'0x3030303'};
const recycled={...base,topics:[SIG.buyback,'0x'+w(1),a(other)],data:'0x'+w(9000000)+a(wallet).slice(2)+w(1000000)};
const transfers=(from,to,raw,index=2)=>({...base,address:usdc,logIndex:'0x'+index.toString(16),topics:[SIG.transfer,a(from),a(to)],data:'0x'+w(raw)});
const raffle = '0xcbc5aa58084aaae6a283101011e6001d7ba7783a';
const raffleLog = (signature, round, index, raw = 0) => ({ ...base, address: raffle,
  topics: [signature, '0x' + w(round), a(wallet)], logIndex: '0x' + index.toString(16), data: '0x' + w(raw) });
const shares = '0x846b419737e4796baa1e2f5ea7b76571d256eac56d566c44767ee2c49ad7f292';
const raffleIncome = raffleLog('0xd04674a07f53a70d82fa6f13a59443dcc4ccd58f8b504604dd61e5982c91f9e3', 6, 7, 6_000_000);
const raffleRefund = raffleLog('0xf3f402280ef0a7905e124aa621b65eaeb2725c343e8b36d398ed78c29daf285c', 2, 9, 3_000_000);
const prizeCard = raffleLog('0xbfb36529287d5a1dcbfbbc958f0a7337a1f5bca269edc737da0be1be702f2251', 1, 10);
const raffleCash = [transfers(wallet, raffle, 4_000_000, 2), transfers(wallet, raffle, 3_000_000, 4),
  transfers(raffle, wallet, 6_000_000, 6), transfers(raffle, wallet, 3_000_000, 8)];
const raffleSettled = raffleEvents(wallet, [prizeCard, raffleIncome, raffleRefund, raffleLog(shares, 1, 3), raffleLog(shares, 2, 5)], raffleCash);
assert.deepEqual(raffleSettled.map(event => [event.requestId, event.category]), [
  ['1', 'raffle-participation'], ['2', 'raffle-participation'], ['6', 'raffle-income'], ['2', 'raffle-refund'], ['1', 'raffle-card'],
]);
const raffleTotals = summarizeWalletEvents(raffleSettled);
assert.equal(raffleTotals.raffleParticipation, '7000000');
assert.equal(raffleTotals.raffleRefund, '3000000');
assert.equal(raffleTotals.raffleCards, '1');
assert.equal(displayWalletTotals(raffleTotals, raffleSettled).net, 2_000_000n);
assert.equal(summarizeWalletEvents(raffleSettled).buybackReceived, '0');
assert.deepEqual(treasuryStaking(wallet, raffleCash, raffleSettled, [], () => true), []);
assert.deepEqual(raffleEvents(wallet, [raffleIncome], [transfers(raffle, wallet, 6_000_001, 6)]), []);
assert.deepEqual(raffleEvents(wallet, [raffleLog(shares, 1, 3)], [transfers(wallet, raffle, 4_000_000, 1)]), []);
const filters = [];
await readRaffleLogs({rpc: async (method, args) => { filters.push([method, args[0]]); return []; }}, wallet, 50_634_768, 54_190_942);
assert.deepEqual(filters.map(([method, filter]) => [method, Number(filter.fromBlock), filter.topics.slice(1)]),
  [['eth_getLogs', 51_472_799, [null, a(wallet)]]], 'raffle history starts at deployment and does not filter by round');

const scanStart = 52_000_000, nextPage = scanStart + 10, scanEnd = scanStart + 100;
const pageLogs = [nextPage - 1, nextPage].flatMap((block, index) => {
  const origin = { transactionHash: '0x' + w(index + 500), blockNumber: '0x' + block.toString(16) };
  return [
    { ...transfers(wallet, raffle, 4_000_000, 2), ...origin },
    { ...raffleLog(shares, index + 1, 3), ...origin },
  ];
});
const outgoingTransfer = { hash: tx, blockNum: '0x' + nextPage.toString(16) };
const walletRanges = [];
const paginatedReader = {
  batch: async calls => calls.map(([method, [hash]]) =>
    method === 'eth_getTransactionReceipt' ? { transactionHash: hash, status: '0x1', logs: [] } : null),
  rpc: async (method, [filter]) => {
    if (method === 'alchemy_getAssetTransfers') {
      return { transfers: [outgoingTransfer], ...(Number(filter.fromBlock) === scanStart ? { pageKey: 'next' } : {}) };
    }
    assert.equal(method, 'eth_getLogs');
    if (![usdc, raffle].includes(filter.address)) return [];
    const from = Number(filter.fromBlock), to = Number(filter.toBlock);
    walletRanges.push([from, to, filter.topics[2]]);
    return pageLogs.filter(log => log.address === filter.address && Number(log.blockNumber) >= from &&
      Number(log.blockNumber) <= to && (filter.address === raffle || filter.topics[1] === a(wallet)));
  },
};
const firstScan = await directWalletReport(wallet, scanStart, scanEnd, paginatedReader, []);
assert.equal(firstScan.to, nextPage - 1);
assert.deepEqual(walletRanges, [
  [scanStart, firstScan.to, a(wallet)],
  [scanStart, firstScan.to, a(wallet)],
  [firstScan.to, firstScan.to, a(raffle)],
], 'wallet logs stop at the NFT page boundary and raffle payments use the contract and exact block');
walletRanges.length = 0;
const secondScan = await directWalletReport(wallet, firstScan.to + 1, scanEnd, paginatedReader, []);
assert.equal(secondScan.to, scanEnd);
assert.deepEqual(walletRanges, [
  [nextPage, scanEnd, a(wallet)],
  [nextPage, scanEnd, a(wallet)],
  [nextPage, nextPage, a(raffle)],
]);
assert.deepEqual([...firstScan.events, ...secondScan.events].map(({ block, raw, category }) => [block, raw, category]), [
  [nextPage - 1, '4000000', 'raffle-participation'],
  [nextPage, '4000000', 'raffle-participation'],
], 'wallet accounting retains both sides of the page boundary');

const drawBlock = scanEnd + 5;
const drawToken = { ...base, blockNumber: '0x' + drawBlock.toString(16),
  topics: [SIG.tokenDraw, '0x' + w(1), '0x' + w(2), a(wallet)], data: '0x' + w(5_000_000) };
const outgoingFilters = [];
const drawReader = {
  batch: async calls => calls.map(([method, [target]]) =>
    method === 'eth_call' && target.to === box ? a(treasury) : null),
  rpc: async (method, [filter]) => {
    if (method === 'alchemy_getAssetTransfers') return { transfers: [] };
    assert.equal(method, 'eth_getLogs');
    if (filter.address === usdc && filter.topics[1] === a(wallet)) outgoingFilters.push(filter);
    if (filter.address.includes(box) && filter.topics[0].includes(SIG.tokenDraw) &&
      Number(filter.fromBlock) <= drawBlock && Number(filter.toBlock) >= drawBlock) return [drawToken];
    return [];
  },
};
const registered = [{ address: box, type: 'token' }];
await directWalletReport(wallet, scanEnd + 1, drawBlock - 1, drawReader, registered);
assert.deepEqual(outgoingFilters, [], 'skip USDC outgoing logs when there are no draws or raffle purchases');
await directWalletReport(wallet, scanEnd + 1, drawBlock + 10, drawReader, registered);
assert.deepEqual(outgoingFilters.map(({ fromBlock, toBlock, topics }) => [Number(fromBlock), Number(toBlock), topics]),
  [[drawBlock, drawBlock, [SIG.transfer, a(wallet)]]], 'draw proof reads all destinations in the matching block');

const denseStart = 53_100_000, denseEnd = denseStart + 819;
const denseDeposits = Array.from({ length: 41_000 }, (_, index) => ({
  ...transfers(treasury, wallet, 1),
  blockNumber: '0x' + (denseStart + Math.floor(index / 50)).toString(16),
  transactionHash: '0x' + w(index + 1000),
}));
const incomeRanges = [];
const denseReader = {
  batch: drawReader.batch,
  rpc: async (method, [filter]) => {
    if (method === 'alchemy_getAssetTransfers') return { transfers: [] };
    assert.equal(method, 'eth_getLogs');
    if (filter.address !== usdc || filter.topics[2] !== a(wallet)) return [];
    const from = Number(filter.fromBlock), to = Number(filter.toBlock);
    incomeRanges.push([from, to]);
    return denseDeposits.filter(log => Number(log.blockNumber) >= from && Number(log.blockNumber) <= to);
  },
};
const firstDense = await directWalletReport(wallet, denseStart, denseEnd, denseReader, registered);
const secondDense = await directWalletReport(wallet, firstDense.to + 1, denseEnd, denseReader, registered);
assert.deepEqual(incomeRanges, [[denseStart, denseEnd]], 'large discovery is reused for a complete second page');
assert.deepEqual([firstDense.to, secondDense.to], [denseStart + 16, denseStart + 33]);
assert.equal(summarizeWalletEvents([...firstDense.events, ...secondDense.events]).staking, '1700');

const nearCacheEnd = denseStart + 790;
const acrossCacheEnd = await directWalletReport(wallet, nearCacheEnd, denseEnd, denseReader, registered);
assert.deepEqual(incomeRanges, [[denseStart, denseEnd], [nearCacheEnd, denseEnd]]);
assert.equal(acrossCacheEnd.to, denseStart + 806, 'an incomplete cached page must be read through the real boundary');
assert.equal(summarizeWalletEvents(acrossCacheEnd.events).staking, '850');

let releaseOutgoing, outgoingFinished = false;
const outgoingGate = new Promise(resolve => { releaseOutgoing = resolve; });
const emergencyRelease = setTimeout(releaseOutgoing, 1_000);
const startedPages = [];
const deferredRanges = [];
const denseDraws = Array.from({ length: 6 }, (_, index) => ({
  ...base,
  blockNumber: '0x' + (denseStart + 17 * index).toString(16),
  transactionHash: '0x' + w(index + 900_000),
  topics: [SIG.draw, '0x' + w(index), a(wallet)],
  data: '0x' + w(5_000_000) + w(1_000_000),
}));
const deferredDeposit = { ...denseDeposits[0], address: box, topics: [SIG.payoutDeferred, a(wallet)] };
const failingPageReader = {
  ...denseReader,
  rpc: async (method, params) => {
    const [filter] = params;
    if (method !== 'eth_getLogs') return denseReader.rpc(method, params);
    const [topic, sender] = filter.topics;
    const from = Number(filter.fromBlock), to = Number(filter.toBlock);
    if (Array.isArray(topic) && topic.includes(SIG.draw)) return denseDraws;
    if (filter.address === usdc && sender === a(wallet)) {
      await outgoingGate;
      outgoingFinished = true;
      return [];
    }
    if (topic === SIG.payoutDeferred) {
      deferredRanges.push([from, to]);
      return [deferredDeposit];
    }
    if (topic === SIG.requestVia) {
      assert.equal(outgoingFinished, false, 'draw sources start while outgoing transfers are pending');
      startedPages.push(from);
      if (startedPages.length === 6) releaseOutgoing();
      if (from === denseStart + 34) throw Error('third page rejected');
      return [];
    }
    return denseReader.rpc(method, params);
  },
};
const batchTarget = denseEnd + 1;
const completedPrefix = await directWalletReportBatch(wallet, denseStart, batchTarget, failingPageReader, registered)
  .finally(() => clearTimeout(emergencyRelease));
assert.deepEqual(startedPages, [0, 17, 34, 51, 68, 85].map(offset => denseStart + offset), 'runs six known pages together');
assert.deepEqual(deferredRanges, [[denseStart, denseStart + 101]], 'the six known pages share one deferred payment query');
assert.equal(completedPrefix.to, denseStart + 33, 'a failed page leaves later pages uncommitted');
assert.equal(summarizeWalletEvents(completedPrefix.events).staking, '1699', 'the shared deferred log excludes the matching payment');
const recoveredPages = await directWalletReportBatch(wallet, completedPrefix.to + 1, denseEnd, denseReader, registered);
assert.equal(recoveredPages.from, denseStart + 34, 'resumes at the first uncommitted block');
assert.equal(recoveredPages.to, denseStart + 135);
assert.equal(summarizeWalletEvents(recoveredPages.events).staking, '5100');

const campaignTransfer = { ...transfers('0xb7ef47bf545c62337ca239f202ca88cf05d14065', auditedCampaignWallet, 45_100_000, 0x2d7),
  transactionHash: '0xbb9ac4f14bee2b9158ecae70735ab7ae099e8a232766b43377232d4aed7aaba6',
  blockNumber: '0x' + (53_530_400).toString(16) };
const campaignEvents = campaignPayoutEvents(auditedCampaignWallet, [campaignTransfer, campaignTransfer]);
const campaignTotals = summarizeWalletEvents(campaignEvents);
assert.equal(campaignTotals.compensation, '44400000');
assert.equal(campaignTotals.campaignPrizes, '700000');
assert.equal(displayWalletTotals(campaignTotals, campaignEvents).net, 45_100_000n);
assert.deepEqual(campaignPayoutEvents(auditedCampaignWallet, [{ ...campaignTransfer, data: '0x' + w(45_100_001) }]), []);
assert.deepEqual(treasuryStaking(auditedCampaignWallet, [campaignTransfer], campaignEvents, [], () => true), []);
const firstWallet = '0xe618f35dfbf4ab79b02b315fd60c69cd289ef75d';
const firstPrize = { ...transfers('0xb7ef47bf545c62337ca239f202ca88cf05d14065', firstWallet, 150_000_000, 0xcf),
  transactionHash: '0x1841d88fac47f5218e07fee8d8db9b127fca4cd7c7ba455b408e6f02b15d4573',
  blockNumber: '0x' + (53_550_004).toString(16) };
assert.equal(summarizeWalletEvents(campaignPayoutEvents(firstWallet, [firstPrize])).campaignPrizes, '150000000');
assert.deepEqual(campaignPayoutEvents(firstWallet, [{ ...firstPrize, logIndex: '0xd0' }]), []);
const fifthWallet = '0xd0983ef1dfbc0d413da6f458ae1524767627967b';
const fifthAirdrop = { ...transfers('0xb7ef47bf545c62337ca239f202ca88cf05d14065', fifthWallet, 21_300_000, 0x16a),
  transactionHash: '0xf4b4b05901850feec4cbc5e361745b5fb0f0b2940910b53405455f9c502fa75f',
  blockNumber: '0x' + (53_530_412).toString(16) };
const fifthAirdropTotals = summarizeWalletEvents(campaignPayoutEvents(fifthWallet, [fifthAirdrop]));
assert.equal(fifthAirdropTotals.compensation, '18300000');
assert.equal(fifthAirdropTotals.campaignPrizes, '3000000');
const fifthUnitemized = { ...transfers('0xb7ef47bf545c62337ca239f202ca88cf05d14065', fifthWallet, 517_000_000, 0x141),
  transactionHash: '0xdc8ef68a54b213b6e9f17e3bbf147921b73277c100af6f5c2d071676da999f22',
  blockNumber: '0x' + (53_268_066).toString(16) };
const fifthUnitemizedEvents = campaignPayoutEvents(fifthWallet, [fifthUnitemized, fifthUnitemized]);
const fifthUnitemizedTotals = summarizeWalletEvents(fifthUnitemizedEvents);
assert.equal(fifthUnitemizedTotals.campaignOther, '517000000');
assert.equal(fifthUnitemizedTotals.compensation, '0');
assert.equal(fifthUnitemizedTotals.campaignPrizes, '0');
assert.equal(displayWalletTotals(fifthUnitemizedTotals, fifthUnitemizedEvents).net, 517_000_000n);
assert.deepEqual(campaignPayoutEvents(fifthWallet, [{ ...fifthUnitemized, blockNumber: '0x1' }]), []);
assert.deepEqual(campaignPayoutEvents(firstWallet, [{ ...fifthUnitemized,
  topics: [SIG.transfer, fifthUnitemized.topics[1], a(firstWallet)] }]), []);

const oldTotals = Object.fromEntries(Object.entries(summarizeWalletEvents([])).filter(([field]) => !field.startsWith('raffle')));
const stored = { version: 3, start: 50_634_768, through: 53_268_066, totals: oldTotals };
const cacheRead = snapshot => walletCachePage(async () => [{ revision: 1, snapshot }], fifthWallet);
const legacy = { ...stored, version: 2, totals: { ...oldTotals, pendingBuybacks: '123' } };
assert.deepEqual(await cacheRead(legacy), {
  ready: true, cached: true, snapshot: { ...legacy, rebuildRequired: true }, usage: { units: 0 },
});
const restored = await cacheRead(stored);
assert.equal(restored.usage.units, 0);
assert.equal(restored.snapshot.totals.raffleParticipation, undefined);
assert.equal(restored.snapshot.totals.campaignOther, '544100000');
assert.equal(restored.snapshot.campaignPayouts.length, 2);
assert.deepEqual((await cacheRead(restored.snapshot)).snapshot, restored.snapshot);
assert.equal((await cacheRead({ ...stored, through: stored.through - 1 })).snapshot.totals.campaignOther, '27100000');
let claims=decodeReward(recycled,wallet).map(e=>({...e,payer:treasury}));
assert.equal(claims.length,1);assert.equal(claims[0].raw,'1000000');
const run=(c,logs,status='0x1')=>reconcileRefunds(c,new Map([[tx,{status,logs}]]),wallet);
assert.equal(run(claims,[transfers(treasury,wallet,1000000)]).filter(e=>e.category==='staking-confirmed').length,1);
assert.equal(run(claims,[]).filter(e=>e.category==='staking-pending').length,1);
assert.equal(run(claims,[transfers(treasury,wallet,1000000)],'0x0').filter(e=>e.category==='staking-confirmed').length,0);
const deferred={...base,topics:[SIG.payoutDeferred,a(wallet)],data:'0x'+w(1000000)};
assert.equal(run(claims,[transfers(treasury,wallet,1000000),deferred]).filter(e=>e.category==='staking-confirmed').length,0);
const self={...recycled,topics:[SIG.buyback,'0x'+w(1),a(wallet)],data:'0x'+w(1000000)+a(wallet).slice(2)+w(1000000)};
assert.equal(run(decodeReward(self,wallet).map(e=>({...e,payer:treasury})),[transfers(treasury,wallet,1000000)]).filter(e=>e.category.endsWith('-confirmed')).length,0,'winner/staker equal payout stays ambiguous');
assert.equal(run([...claims,{...claims[0],id:'refund',category:'refund'}],[transfers(treasury,wallet,1000000)]).filter(e=>e.category.endsWith('-confirmed')).length,0,'cross-category receipt cannot count twice');
const stakingBatch = [5, 9].flatMap((index, i) => decodeReward({ ...recycled,
  logIndex: '0x' + index.toString(16), topics: [SIG.buyback, '0x' + w(i + 1), a(other)],
}, wallet)).map(event => ({ ...event, payer: treasury }));
const batchStake = logs => run(stakingBatch, logs).filter(e => e.category === 'staking-confirmed');
const stakerPayments = [3, 7].map(index => transfers(treasury, wallet, 1_000_000, index));
assert.deepEqual(batchStake(stakerPayments).map(e => e.logIndex), [3, 7]);
assert.equal(batchStake([stakerPayments[0], transfers(treasury, wallet, 1_000_000, 6)]).length, 0);
assert.equal(batchStake([...stakerPayments, deferred]).length, 0);
assert.deepEqual(decodeReward({...recycled,topics:[SIG.kept]},wallet),[],'NFT disposal is not staking yield');
const draw={id:'draw',contract:box,tx,category:'pack',packKind:'card',requestId:'7',raw:'11000000',paidRaw:'10000000',feeRaw:'1000000',paymentVerified:true,sourceStatus:'legacy-receipt',block:1};
assert(verifyDrawPayments([draw],{status:'0x1',logs:[transfers(wallet,treasury,10000000),transfers(wallet,other,1000000,3)]},wallet,treasury,other));
assert(!verifyDrawPayments([draw],{status:'0x1',logs:[transfers(other,treasury,10000000),transfers(wallet,other,1000000,3)]},wallet,treasury,other),'payer must be wallet');
assert(!verifyDrawPayments([draw],{status:'0x1',logs:[transfers(wallet,treasury,9999999),transfers(wallet,other,1000000,3)]},wallet,treasury,other));
assert(verifyDrawPayments([draw,{...draw,id:'draw2'}],{status:'0x1',logs:[transfers(wallet,treasury,20000000),transfers(wallet,other,2000000,3)]},wallet,treasury,other),'batch draw expenditures conserved');
const tokenDraws = Array.from({ length: 5 }, (_, i) => ({ packKind: 'token', raw: '200000000', requestId: String(i + 1) }));
const tokenReceipt = { status: '0x1', logs: [transfers(wallet, treasury, 1_000_000_000)] };
assert(verifyDrawPayments(tokenDraws, tokenReceipt, wallet, treasury));
assert(!verifyDrawPayments(tokenDraws.slice(1), tokenReceipt, wallet, treasury));
assert(!verifyDrawPayments(tokenDraws, tokenReceipt, wallet, other));
const won={id:'won',contract:box,category:'won',requestId:'7',winId:'8',collection:nft,tokenId:'9',block:2};
const kept={id:'kept',contract:box,category:'kept',winId:'8',collection:nft,tokenId:'9',block:3,acquisitionVerified:true};
const cost=e=>linkAcquisitionCosts(e)[0]?.acquisitionCostRaw;
assert.equal(cost([draw,won,kept]),'11000000');
assert.equal(cost([draw,draw,won,kept]),'11000000','exact duplicates excluded');
for(const events of [[won,kept],[{...draw,paymentVerified:false},won,kept],[{...draw,sourceStatus:'adapter-source-unresolved'},won,kept],[draw,{...draw,id:'duplicateRequest'},won,kept],[draw,won,{...won,id:'secondOutcome',winId:'10'},kept],[draw,won,{...kept,acquisitionVerified:false}],[draw,won,kept,{id:'refund',category:'refund-pending',contract:box,requestId:'7'}],[draw,won,kept,{...kept,id:'recycle',category:'buyback'}]])assert.equal(cost(events),null);
assert.deepEqual(linkAcquisitionCosts([draw,won]),[],'won alone is not retained acquisition');
console.log('PASS: staking receipt/defer/ambiguity and conserved draw-to-kept-NFT expenditure cases');
const winnerLog={...recycled,topics:[SIG.buyback,'0x'+w(1),a(wallet)],data:'0x'+w(9000000)+a(other).slice(2)+w(1000000)};
const winnerClaims=decodeReward(winnerLog,wallet).map(e=>({...e,payer:treasury}));
assert.equal(winnerClaims.length,1);assert.equal(winnerClaims[0].category,'buyback-claim');
assert.equal(run(winnerClaims,[transfers(treasury,wallet,9000000)]).filter(e=>e.category==='buyback-claim-confirmed').length,1);
assert.equal(run(winnerClaims,[transfers(treasury,wallet,9000000)],'0x0').filter(e=>e.category==='buyback-claim-confirmed').length,0);
assert.equal(run([...winnerClaims,{...winnerClaims[0],id:'refund-same',category:'refund'}],[transfers(treasury,wallet,9000000)]).filter(e=>e.category.endsWith('-confirmed')).length,0);
const batchClaims = [5, 9].flatMap((index, i) => decodeReward({ ...winnerLog, logIndex: '0x' + index.toString(16),
  topics: [SIG.buyback, '0x' + w(i + 1), a(wallet)] }, wallet).map(event => ({ ...event, payer: treasury })));
const batchTransfers = [2, 6].map(index => transfers(treasury, wallet, 9000000, index));
const matchedBatch = run(batchClaims, batchTransfers).filter(event => event.category === 'buyback-claim-confirmed');
assert.deepEqual(matchedBatch.map(event => event.logIndex), [2, 6]);
assert.equal(run(batchClaims, batchTransfers.slice(0, 1)).filter(event => event.category.endsWith('-confirmed')).length, 0);
assert.equal(run(batchClaims, [batchTransfers[0], transfers(treasury, wallet, 9000000, 7)])
  .filter(event => event.category.endsWith('-confirmed')).length, 0);
assert.equal(run(batchClaims, [...batchTransfers, {...deferred, data: '0x' + w(9000000)}])
  .filter(event => event.category.endsWith('-confirmed')).length, 0);
const keptBatch = batchClaims.map((event, i) => ({ ...event, category: 'kept-disposal', buybackKind: undefined,
  releaseId: `release-${i}`, raw: '4000000' }));
const keptTransfers = [2, 6].map(index => transfers(treasury, wallet, 4_000_000, index));
const confirmedKept = (claims, logs) => run(claims, logs).filter(event => event.category === 'kept-disposal-confirmed');
assert.deepEqual(confirmedKept(keptBatch, keptTransfers).map(event => event.logIndex), [2, 6]);
assert.equal(confirmedKept(keptBatch.map(event => ({ ...event, releaseId: 'duplicate' })), keptTransfers).length, 0);
const selfUnequal={...winnerLog,data:'0x'+w(9000000)+a(wallet).slice(2)+w(1000000)};
const dualPaid=run(decodeReward(selfUnequal,wallet).map(e=>({...e,payer:treasury})),[transfers(treasury,wallet,9000000),transfers(treasury,wallet,1000000,3)]);
assert.equal(dualPaid.filter(e=>e.category.endsWith('-confirmed')).length,2);
assert.equal(new Set(dualPaid.filter(e=>e.category.endsWith('-confirmed')).map(e=>e.id)).size,2);
const saleEvidence={...winnerClaims[0],id:tx+':0x2',category:'sales'};
assert.equal(run([...winnerClaims,saleEvidence],[transfers(treasury,wallet,9000000)]).filter(e=>e.category==='buyback-claim-confirmed').length,0,'already counted sales receipt cannot be winner buyback');
const tokenRecycle={...winnerLog,topics:[SIG.tokenBuyback,'0x'+w(1),a(wallet)],data:'0x'+w(1710000000)+w(95000000)};
const tokenClaims=decodeReward(tokenRecycle,wallet).map(e=>({...e,payer:treasury}));
assert.deepEqual(tokenClaims.map(e=>[e.category,e.raw]),[['buyback-claim','1710000000']]);
assert.deepEqual(decodeReward(tokenRecycle,other),[],'TokenBlindBox does not identify the staker');
assert.equal(run(tokenClaims,[transfers(treasury,wallet,1710000000)]).find(e=>e.category==='buyback-claim-confirmed')?.raw,'1710000000');
assert.equal(run(tokenClaims,[transfers(other,wallet,1710000000)]).filter(e=>e.category==='buyback-claim-confirmed').length,0);
console.log('PASS: winner buybacks confirmed only once, cross-refund/sale conflicts excluded, unequal dual payouts distinct');
const keptSettlement={...base,logIndex:'0x4',topics:[SIG.kept,'0x'+w(8),a(other)],data:'0x'+w(4000000),dispositionCandidate:true};
const release={...base,address:STAKE,logIndex:'0x3',topics:[SIG.tokenReleased,a(nft),'0x'+w(9),a(other)],data:'0x'};
const payment=transfers(treasury,wallet,4000000);
const winState='0x'+[a(other),a(nft),'0x'+w(9),'0x'+w(4000000),a(wallet),'0x'+w(0),'0x'+w(1)].map(x=>x.slice(2)).join('');
const stateCalls=evidencePlan([keptSettlement],true).calls.map(call=>{
 const selector=call[1][0].data.slice(0,10);
 return callRecord(call,selector==='0x61d027b3'?a(treasury):selector==='0x7b9e618d'?a(usdc):winState);
});
const settleKeep=async (logs,calls=stateCalls)=>summarizeWalletEvents((await settleRecordedWallet(wallet,[keptSettlement],
 [{tx,receipt:{status:'0x1',logs}}],calls,[],true)).events);
const proceeds=await settleKeep([payment,release]);
assert.equal(proceeds.keptDisposal,'4000000');
assert.equal(proceeds.staking,'0');
assert.equal((await settleKeep([payment])).keptDisposal,'0','pool release evidence is required');
assert.equal((await settleKeep([payment,release,transfers(treasury,wallet,4000000,5)])).keptDisposal,'0','same-amount payments remain ambiguous');

const mixedBuyback = { ...winnerLog, data: '0x' + w(2_574_000_000) + a(other).slice(2) + w(0) };
const refundHash = '0x' + w(200);
const refundLog = { ...base, transactionHash: refundHash, topics: [SIG.refund, '0x' + w(2), a(wallet)], data: '0x' + w(30_000_000) };
const deposits = Array.from({ length: 132 }, (_, index) => ({ ...transfers(treasury, wallet, 200_000),
  transactionHash: '0x' + w(index + 1), blockNumber: '0x' + (Number(base.blockNumber) + index + 1).toString(16) }));
const deferredPayment = { ...deposits[2], address: box, logIndex: '0x1', topics: [SIG.payoutDeferred, a(wallet)] };
const stakingPayment = transfers(treasury, wallet, 143_000_000, 3);
const cash = [transfers(treasury, wallet, 2_574_000_000), stakingPayment, stakingPayment,
  { ...transfers(treasury, wallet, 30_000_000), transactionHash: refundHash },
  ...deposits, ...deposits.slice(0, 2).map(log => ({ ...log, logIndex: '0x3' })),
  { ...transfers(other, wallet, 9_000_000), transactionHash: '0x' + w(201) }];
const directLogs = [mixedBuyback, refundLog];
const reader = {
  batch: async calls => {
    assert.equal(calls.length, 0, 'treasury inflows never trigger a receipt lookup');
    return [];
  },
  rpc: async (method, [filter]) => {
    assert.equal(method, 'eth_getLogs');
    assert.deepEqual(filter.topics, [SIG.payoutDeferred, a(wallet)]);
    return [deferredPayment];
  },
};
const proof = await walletEvidence(reader, wallet, new Map(directLogs.map(log => [log.transactionHash, log])),
  cash, [], [box], new Set([box]), { audited: () => false, isTreasury: payer => payer === treasury },
  Number(base.blockNumber), Number(deposits.at(-1).blockNumber));
const payoutCalls = evidencePlan(directLogs, true).calls.map(call =>
  callRecord(call, call[1][0].data === '0x61d027b3' ? a(treasury) : a(usdc)));
const { events: paidEvents } = await settleRecordedWallet(wallet, directLogs, proof.receipts, payoutCalls, [], true);
const isTreasury = payer => payer === treasury;
const residuals = treasuryStaking(wallet, cash, paidEvents, proof.deferred, isTreasury);
assert.equal(residuals.length, 130, '129 deposits plus the mixed payout; two ambiguous and one deferred deposit excluded');
assert(residuals.some(event => event.id === `${tx}:0x3` && event.raw === '143000000'));
const coldTotals = summarizeWalletEvents([...paidEvents, ...residuals]);
assert.equal(coldTotals.staking, '168800000');
assert.equal(coldTotals.refund, '30000000');
assert.equal(coldTotals.buybackReceived, '2574000000');
assert.equal(displayWalletTotals(addWalletTotals({ staking: '1000000', stakingCount: '1' }, coldTotals), []).stakingInflow, 169_800_000n);
const unresolvedRefund = { tx: deposits[3].transactionHash, raw: '200000', category: 'refund-pending' };
assert.equal(treasuryStaking(wallet, cash, [...paidEvents, unresolvedRefund], proof.deferred, isTreasury).length, 129);

const indexedBatchHash = '0x' + w(300);
const indexedBatch = [5, 9].map((index, i) => ({ ...winnerLog, transactionHash: indexedBatchHash,
  logIndex: '0x' + index.toString(16), topics: [SIG.buyback, '0x' + w(i + 1), a(wallet)] }));
const indexedPayments = batchTransfers.map(log => ({ ...log, transactionHash: indexedBatchHash }));
const hiddenStakes = [5, 9].map((index, i) => ({ ...recycled, logIndex: '0x' + index.toString(16),
  topics: [SIG.buyback, '0x' + w(i + 1), a(other)] }));
const indexedLogs = new Map(indexedBatch.map(log => [log.transactionHash + ':' + log.logIndex, log]));
const mixedEvidence = await walletEvidence({
  batch: async calls => {
    assert.deepEqual(calls, [['eth_getTransactionReceipt', [tx]]], 'only the unindexed same-amount settlement needs proof');
    return [{ transactionHash: tx, status: '0x1', logs: [...hiddenStakes, ...stakerPayments] }];
  },
  rpc: async () => [],
}, wallet, indexedLogs, [...indexedPayments, ...stakerPayments], [], [box], new Set([box]),
{ audited: () => true, isTreasury }, Number(base.blockNumber), Number(base.blockNumber));
const discovered = [...indexedLogs.values()];
const discoveredCalls = evidencePlan(discovered, true).calls.map(call =>
  callRecord(call, call[1][0].data === '0x61d027b3' ? a(treasury) : a(usdc)));
const discoveredTotals = summarizeWalletEvents((await settleRecordedWallet(wallet, discovered,
  mixedEvidence.receipts, discoveredCalls, [], true)).events);
assert.equal(discoveredTotals.staking, '2000000');
assert.equal(discoveredTotals.buybackReceived, '18000000');

const treasuryChanged = { ...base, blockNumber: '0x64', topics: [SIG.treasuryUpdated, a(other)] };
const history = await walletStateHistory({
  batch: async calls => calls.map(([method, [target, block]]) => method === 'eth_call' && target.to === box
    ? a(block === '0x63' ? treasury : other) : null),
  rpc: async (method, [filter]) => filter.address.includes(box) ? [treasuryChanged] : [],
}, [box], 80, 120);
assert(history.isTreasury(treasury, 99));
assert(!history.isTreasury(other, 99));
assert(!history.isTreasury(treasury, 100) && !history.isTreasury(other, 100));
assert(history.isTreasury(other, 101));
assert(!history.isTreasury(treasury, 101));
console.log('PASS: 132 cold treasury transactions use zero receipt calls; cash categories, ambiguity and incremental totals preserved');
