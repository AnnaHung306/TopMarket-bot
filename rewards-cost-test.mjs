import assert from 'node:assert/strict';
import {decodeReward,reconcileRefunds,verifyDrawPayments,linkAcquisitionCosts,SIG,STAKE} from './worker/index.js';
import {callRecord,evidencePlan} from './worker/history/chain.js';
import {settleRecordedWallet} from './worker/history/report.js';
import {treasuryStaking} from './worker/history/treasury-staking.js';
import {walletEvidence} from './worker/history/wallet-evidence.js';
import {walletStateHistory} from './worker/history/wallet-state.js';
import {addWalletTotals, displayWalletTotals, summarizeWalletEvents} from './worker/report/accounting.js';
const wallet='0x'+'1'.repeat(40),box='0x'+'2'.repeat(40),treasury='0x'+'3'.repeat(40),other='0x'+'4'.repeat(40),nft='0x'+'5'.repeat(40),usdc='0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',tx='0x'+'a'.repeat(64);
const w=n=>BigInt(n).toString(16).padStart(64,'0'),a=s=>'0x'+s.slice(2).padStart(64,'0');
const base={address:box,transactionHash:tx,logIndex:'0x1',blockNumber:'0x3030303'};
const recycled={...base,topics:[SIG.buyback,'0x'+w(1),a(other)],data:'0x'+w(9000000)+a(wallet).slice(2)+w(1000000)};
const transfers=(from,to,raw,index=2)=>({...base,address:usdc,logIndex:'0x'+index.toString(16),topics:[SIG.transfer,a(from),a(to)],data:'0x'+w(raw)});
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
assert.deepEqual(decodeReward({...recycled,topics:[SIG.kept]},wallet),[],'NFT disposal is not staking yield');
const draw={id:'draw',contract:box,tx,category:'pack',packKind:'card',requestId:'7',raw:'11000000',paidRaw:'10000000',feeRaw:'1000000',paymentVerified:true,sourceStatus:'legacy-receipt',block:1};
assert(verifyDrawPayments([draw],{status:'0x1',logs:[transfers(wallet,treasury,10000000),transfers(wallet,other,1000000,3)]},wallet,treasury,other));
assert(!verifyDrawPayments([draw],{status:'0x1',logs:[transfers(other,treasury,10000000),transfers(wallet,other,1000000,3)]},wallet,treasury,other),'payer must be wallet');
assert(!verifyDrawPayments([draw],{status:'0x1',logs:[transfers(wallet,treasury,9999999),transfers(wallet,other,1000000,3)]},wallet,treasury,other));
assert(verifyDrawPayments([draw,{...draw,id:'draw2'}],{status:'0x1',logs:[transfers(wallet,treasury,20000000),transfers(wallet,other,2000000,3)]},wallet,treasury,other),'batch draw expenditures conserved');
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
  cash, [], [box], new Set([box]), { audited: () => false }, Number(base.blockNumber), Number(deposits.at(-1).blockNumber));
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
