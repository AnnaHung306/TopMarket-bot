import { renderWalletReport } from './report/page.js';

const ALCHEMY_KEY=globalThis.process?.env?.ALCHEMY_API_KEY?.trim();
const RPC=ALCHEMY_KEY?'https://base-mainnet.g.alchemy.com/v2':'https://base-rpc.publicnode.com';
const FACTORIES=['0x0e218eddfed2b6e482d2989d05c6db0ee41db2f2','0x8f142f5bbc4061df7c84b4990ce9081e4acd4abf'];
const FACTORY_DEPLOYMENTS=[50636771,52098220];
const MARKET='0xf20658ec88403e9a26d77fb95e91c1248d9818ea',STAKE='0xde16e61171ca80c169ecb82e9328118ae5958369',USDC='0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const SIG={requestVia:'0xba25fefcb40ae654f130e3be6b73de7f0ccf2b8441ec58a2ad8366d3be8d2e54',feeRecipientUpdated:'0x7a7b5a0a132f9e0581eb8527f66eae9ee89c2a3e79d4ac7e41a1f1f4d48a7fc2',treasuryUpdated:'0x7dae230f18360d76a040c81f050aa14eb9d6dc7901b20fc5d855e2a20fe814d1',payoutDeferred:'0x0e54be18cea4b7c02dcb455aa29944656f9f30fbb0ba328fe8a75d10e52511dd',draw:'0xdb439e6080e1209a20f9d35abe6f80219c3e5fd9d9bb0f07c8a784ee5c58055b',tokenDraw:'0xd93114e64a2d27c65b12cd13e827517eba84ef21832db9a365f3b745f13b522d',refund:'0xfefb3e5c0d062b34e87c5f8290c51731d2229099c7f000e7780d8b3fe44b45e0',rescue:'0x1828d2f3000b31d9ff70785eaf88e43ed44e8b732bda61ecad9e36f812511540',buyback:'0xaec8469c085e128de99c809d38f9c07e565663dfd29b128d537fd205ffa94c27',tokenBuyback:'0x55919353708fdaf1559aaa0cb60096e7885b0c3a4ef0bc3fcc7a83301963987a',kept:'0x6a06d823c45c17db1b2ce7efbcebfc5c0f82b756b3ce522fa4179a132448439a',transfer:'0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',won:'0xafa41f2c37f02935fa60ede2a9236a4d823678634694ff89b191000ce21a7ff7',sold:'0x0bfbe42bbfa7e9dbd4093c84bc4c056f76ae3392d4692bf3e798130e4398ff46',offer:'0xfe32bff8f34618a1622914ef3a11f01ef84838224733f36409e9b8731974a7c3',staked:'0x9f9e4044c5742cca66ca090b21552bac14645e68bad7a92364a9d9ff18111a1c',unstaked:'0xe85b7860587d17eba1b921a125cf25732cd9e64d1516f196df3c9c8fb8d513f3',auction:'0xc9f72b276a388619c6d185d146697036241880c36654b1a3ffdad07c24038d99'};
const hex=n=>'0x'+Number(n).toString(16),word=a=>'0x'+a.slice(2).padStart(64,'0'),words=data=>data.slice(2).match(/.{64}/g)||[],addr=x=>'0x'+x.slice(-40).toLowerCase(),valid=a=>/^0x[0-9a-fA-F]{40}$/.test(a);
SIG.tokenReleased='0x22c48950706d393b833ea45eaaa6128d8de712bd864d44b66a18982f7a09391d';
const cashClaimCategories=new Set(['refund','staking','buyback-claim','kept-disposal']);
function rpcError(message,defaultMessage){
  const text=typeof message==='string'&&message?message:defaultMessage;
  return Error(ALCHEMY_KEY?text.replaceAll(ALCHEMY_KEY,'[redacted]'):text);
}
async function rpcRequest(payload){
  const headers={'content-type':'application/json'};
  if(ALCHEMY_KEY) headers.authorization='Bearer '+ALCHEMY_KEY;
  try{
    const response=await fetch(RPC,{method:'POST',headers,body:JSON.stringify(payload),signal:AbortSignal.timeout(20000)});
    if(!response.ok){
      const body=await response.json().catch(()=>null);
      const error=rpcError(body?.error?.message,'Base RPC HTTP '+response.status);
      error.status=response.status;
      throw error;
    }
    return await response.json();
  }catch(error){
    if(error.status)throw error;
    throw rpcError(error.message,'Base RPC request failed');
  }
}
async function rpc(method,params){
  const response=await rpcRequest({jsonrpc:'2.0',id:1,method,params});
  if(response.error) throw rpcError(response.error.message,'Base RPC error');
  return response.result;
}
async function batch(calls,partial=false){
  const out=[];
  for(let i=0;i<calls.length;i+=25){
    const chunk=calls.slice(i,i+25);
    const data=await rpcRequest(chunk.map(([method,params],id)=>({jsonrpc:'2.0',id,method,params})));
    if(!Array.isArray(data)) throw rpcError(data.error?.message,'Invalid RPC batch');
    out.push(...chunk.map((_,id)=>{
      const response=data.find(entry=>entry.id===id);
      if(!response||response.error){
        if(partial) return null;
        throw rpcError(response?.error?.message,'Incomplete RPC batch');
      }
      return response.result;
    }));
  }
  return out;
}
async function boxes(at='latest',readBatch=batch){
 const factories=FACTORIES.map((to,index)=>({to,type:index?'token':'card',deployment:FACTORY_DEPLOYMENTS[index]}))
  .filter(({deployment})=>!Number.isFinite(Number(at))||Number(at)>=deployment);
 const counts=await readBatch(factories.map(({to})=>['eth_call',[{to,data:'0x44ff038f'},at]]));
 const calls=[],types=[];
 counts.forEach((value,index)=>{
  const {to,type}=factories[index],count=Number(BigInt(value));
  if(count>200)throw Error('Factory registry exceeded safety limit');
  for(let i=0;i<count;i++){
   calls.push(['eth_call',[{to,data:'0x8df87e02'+i.toString(16).padStart(64,'0')},at]]);
   types.push(type);
  }
 });
 return (await readBatch(calls)).map((value,index)=>({address:addr(value),type:types[index]}));
}
let cachedRegistry,cacheTime=0;async function registry(){if(cachedRegistry&&Date.now()-cacheTime<300000)return cachedRegistry;const b=await boxes();let collectionCount=null,collectionsError=null;try{collectionCount=Number(BigInt(await rpc('eth_call',[{to:STAKE,data:'0xd57f966b'},'latest'])));}catch(e){collectionsError=e.message;}cachedRegistry={boxes:b,collectionCount,collectionsError};cacheTime=Date.now();return cachedRegistry;}
function base(log){return{id:log.transactionHash+':'+log.logIndex,tx:log.transactionHash,block:Number(BigInt(log.blockNumber)),logIndex:Number(BigInt(log.logIndex)),contract:log.address,requestId:null};}
function decode(log){const vals=words(log.data),val=i=>BigInt('0x'+(vals[i]||'0')),sig=log.topics[0];let category,amount,extra={};if(sig===SIG.draw){category='pack';amount=val(0)+val(1);extra={packKind:'card',paidRaw:val(0).toString(),feeRaw:val(1).toString()};}else if(sig===SIG.tokenDraw){category='pack';amount=val(0);extra={packKind:'token'};}else if(sig===SIG.refund||sig===SIG.rescue){category='refund';amount=val(0);}else if(sig===SIG.buyback||sig===SIG.tokenBuyback){category='buyback';amount=val(0);}else if(sig===SIG.kept){category='kept';amount=null;}else if(sig===SIG.won){category='won';amount=null;extra={collection:addr(vals[0]),tokenId:val(1).toString(),requestId:BigInt(log.topics[2]).toString(),winId:BigInt(log.topics[1]).toString()};}else if(sig===SIG.staked||sig===SIG.unstaked){category=sig===SIG.staked?'staked':'unstaked';amount=null;extra={collection:addr(log.topics[1]),tokenId:BigInt(log.topics[2]).toString()};}else if(sig===SIG.transfer){category='refund-transfer';amount=val(0);}else return null;return {...base(log),requestId:['pack','refund'].includes(category)?BigInt(log.topics[1]).toString():null,winId:['buyback','kept'].includes(category)?BigInt(log.topics[1]).toString():null,category,raw:amount===null?null:amount.toString(),amount:amount===null?null:Number(amount)/1e6,...extra};}
function decodeMarket(log,wallet){const v=words(log.data),seller=addr(v[0]),buyer=addr(log.topics[3]);if(seller!==wallet&&buyer!==wallet)return null;const currency=addr(v[1]),raw=BigInt('0x'+v[2]).toString();return {...base(log),category:seller===buyer?'selfTrade':seller===wallet?'saleGross':'purchaseGross',collection:addr(log.topics[1]),tokenId:BigInt(log.topics[2]).toString(),seller,buyer,currency,raw:currency===USDC?raw:null,amount:currency===USDC?Number(raw)/1e6:null,currencyRaw:raw};}
// A latest-state getter is not historical evidence. Reject any treasury update in
// the whole settlement block, including a change followed by a change back.
function historicalPayerEvidence(before,after,tokenBefore,tokenAfter,updates){
 const addressResult=x=>typeof x==='string'&&/^0x0{24}[0-9a-fA-F]{40}$/.test(x)?addr(x):null;
 const payer=addressResult(before),end=addressResult(after);
 if(!payer||!end||payer==='0x'+'0'.repeat(40)||payer!==end)return {payer:null,payerError:'Historical treasury unavailable or changed'};
 if(addressResult(tokenBefore)!==USDC||addressResult(tokenAfter)!==USDC)return {payer:null,payerError:'Historical settlement token not verified as USDC'};
 if(!Array.isArray(updates)||updates.length)return {payer:null,payerError:'Treasury changed during settlement block or update history unavailable'};
 return {payer,payerEvidence:'treasury() and settlementToken() at block-1/block; no block TreasuryUpdated logs'};
}
async function resolveRefundPayers(events,readBatch=batch){
 const claims=events.filter(e=>cashClaimCategories.has(e.category));
 const groups=[...new Map(claims.map(e=>[e.contract.toLowerCase()+':'+e.block,e])).values()];
 const proofs=new Map();
 for(const e of groups){const key=e.contract.toLowerCase()+':'+e.block;try{
  const call=(selector,block)=>['eth_call',[{to:e.contract,data:selector},hex(block)]];
  const values=await readBatch([call('0x61d027b3',e.block-1),call('0x61d027b3',e.block),call('0x7b9e618d',e.block-1),call('0x7b9e618d',e.block),['eth_getLogs',[{address:e.contract,fromBlock:hex(e.block),toBlock:hex(e.block),topics:[SIG.treasuryUpdated]}]]],true);
  proofs.set(key,historicalPayerEvidence(...values));
 }catch{proofs.set(key,{payer:null,payerError:'Historical treasury/token lookup unavailable'});}}
 return events.map(e=>cashClaimCategories.has(e.category)?{...e,...proofs.get(e.contract.toLowerCase()+':'+e.block)}:e);
}
function reconcileRefunds(input,receiptMap,wallet){
 const events=[...new Map(input.map(event=>[event.id,event])).values()];
 const claims=events.filter(event=>cashClaimCategories.has(event.category));
 const claimSources=new Set(claims.map(event=>event.tx+':'+event.contract.toLowerCase()));
 const sales=new Set(events.filter(event=>event.category==='sales').map(event=>event.id));
 const cash=new Map();
 const deferred=new Set();
 const matchKey=(tx,payer,raw)=>tx+':'+payer+':'+raw;
 for(const tx of new Set(claims.map(event=>event.tx))){
  const receipt=receiptMap.get(tx);
  for(const log of receipt?.logs||[]){
   const source=log.address.toLowerCase();
   if(log.topics[0]===SIG.payoutDeferred&&log.topics.length>=2&&addr(log.topics[1])===wallet&&claimSources.has(tx+':'+source)){
    deferred.add(matchKey(tx,source,BigInt(log.data).toString()));
   }
   if(receipt.status!=='0x1'||source!==USDC||log.topics[0]!==SIG.transfer||
     log.topics.length<3||addr(log.topics[2])!==wallet)continue;
   const transfer=base(log);
   if(sales.has(transfer.id))continue;
   const amount=BigInt(log.data);
   cash.set(transfer.id,{...transfer,payer:addr(log.topics[1]),raw:amount.toString(),amount:Number(amount)/1e6});
  }
 }
 const transfersByKey=new Map(), cashAmounts=new Set(), claimsByKey=new Map();
 for(const transfer of cash.values()){
  const key=matchKey(transfer.tx,transfer.payer,transfer.raw);
  if(!transfersByKey.has(key))transfersByKey.set(key,[]);
  transfersByKey.get(key).push(transfer);
  cashAmounts.add(transfer.tx+':'+transfer.raw);
 }
 for(const claim of claims){
  if(!claim.payer)continue;
  const key=matchKey(claim.tx,claim.payer.toLowerCase(),claim.raw);
  if(!claimsByKey.has(key))claimsByKey.set(key,[]);
  claimsByKey.get(key).push(claim);
 }
 const batchPayouts=new Map();
 for(const [key,group] of claimsByKey){
  const candidates=transfersByKey.get(key)||[];
  const first=group[0];
  if(group.length<2||group.length!==candidates.length)continue;
  const offset=first.category==='staking'?2
   :first.category==='kept-disposal'||first.category==='buyback-claim'&&first.buybackKind==='card'?3:0;
  if(!offset||group.some(claim=>claim.category!==first.category||claim.buybackKind!==first.buybackKind||claim.contract!==first.contract))continue;
  if(new Set(group.map(claim=>claim.winId)).size!==group.length)continue;
  if(first.category==='kept-disposal'&&(group.some(claim=>!claim.releaseId)||new Set(group.map(claim=>claim.releaseId)).size!==group.length))continue;
  if(deferred.has(matchKey(first.tx,first.contract.toLowerCase(),first.raw)))continue;
  // Card settlements emit the relevant transfer at a fixed offset from the outcome log.
  const byPosition=new Map(candidates.map(transfer=>[transfer.logIndex,transfer]));
  const matches=group.map(claim=>byPosition.get(claim.logIndex-offset));
  if(matches.every(Boolean)&&new Set(matches).size===group.length){
   group.forEach((claim,index)=>batchPayouts.set(claim.id,matches[index]));
  }
 }
 const confirmed=new Map();
 const out=events.map(event=>{
  if(event.category==='refund-transfer')return {...event,category:'refund-pending',reason:'User-supplied source transfer; refund purpose not uniquely verified'};
  if(!cashClaimCategories.has(event.category))return event;
  const key=event.payer&&matchKey(event.tx,event.payer.toLowerCase(),event.raw);
  const candidates=transfersByKey.get(key)||[];
  const payoutDeferred=deferred.has(matchKey(event.tx,event.contract.toLowerCase(),event.raw));
  const transfer=candidates.length===1&&claimsByKey.get(key)?.length===1?candidates[0]:batchPayouts.get(event.id);
  if(!payoutDeferred&&transfer){
   const disposition=event.category==='kept-disposal'?{collection:event.collection,tokenId:event.tokenId,winId:event.winId}:{};
   confirmed.set(transfer.id,{...transfer,...disposition,category:event.category+'-confirmed',requestId:event.requestId,claimId:event.id,reconciled:true});
   return {...event,category:event.category+'-evidence',receiptId:transfer.id};
  }
  const reason=payoutDeferred?'Matching payout deferred; cash attribution unresolved'
   :!receiptMap.get(event.tx)?'Receipt unavailable'
   :!cashAmounts.has(event.tx+':'+event.raw)?'No matching same-transaction USDC amount'
   :!event.payer?(event.payerError||'Historical treasury payer unknown')
   :candidates.length?'Ambiguous event/transfer mapping; possible duplicate'
   :'No unique same-payer, same-amount USDC receipt';
  return {...event,category:event.category+'-pending',reason};
 });
 // Replace only the exact matched transfer identity.
 return out.filter(event=>!confirmed.has(event.id)).concat([...confirmed.values()]);
}
function decodeReward(log,wallet){
 const token=log.topics[0]===SIG.tokenBuyback;
 if(!token&&log.topics[0]!==SIG.buyback)return [];
 const v=words(log.data);if(v.length!==(token?2:3))return [];
 const winner=addr(log.topics[2]),out=[];
 if(!token&&addr(v[1])===wallet)out.push({...base(log),id:base(log).id+':staking',category:'staking',winId:BigInt(log.topics[1]).toString(),raw:BigInt('0x'+v[2]).toString(),amount:Number(BigInt('0x'+v[2]))/1e6});
 if(winner===wallet)out.push({...base(log),id:base(log).id+':buyback',category:'buyback-claim',buybackKind:token?'token':'card',winId:BigInt(log.topics[1]).toString(),raw:BigInt('0x'+v[0]).toString(),amount:Number(BigInt('0x'+v[0]))/1e6});
 return out;
}
function verifyDrawPayments(packs,receipt,wallet,payer,feeRecipient){
 if(!receipt||receipt.status!=='0x1'||!payer||payer===wallet||!packs.length)return false;
 const kind=packs[0].packKind;
 if(!['card','token'].includes(kind)||packs.some(p=>p.packKind!==kind))return false;
 if(kind==='card'&&(!feeRecipient||feeRecipient===wallet))return false;
 const expected=new Map();
 for(const pack of packs){
  const transfers=kind==='token'?[[payer,pack.raw]]:[[payer,pack.paidRaw],[feeRecipient,pack.feeRaw]];
  for(const [to,raw] of transfers)expected.set(to,(expected.get(to)||0n)+BigInt(raw));
 }
 const actual=new Map();for(const l of receipt.logs||[]){if(l.address.toLowerCase()!==USDC||l.topics[0]!==SIG.transfer||l.topics.length!==3||addr(l.topics[1])!==wallet)continue;const to=addr(l.topics[2]);actual.set(to,(actual.get(to)||0n)+BigInt(l.data));}
 return [...expected].every(([to,n])=>(actual.get(to)||0n)===n)&&[...actual].every(([to,n])=>(expected.get(to)||0n)===n);
}
async function keptDisposals(logs,receipts,wallet,readRpc){
 const claims=[];
 for(const log of logs){
  const receipt=receipts.get(log.transactionHash);
  if(receipt?.status!=='0x1')continue;
  const result=await readRpc('eth_call',[{to:log.address,data:'0x80bfe883'+log.topics[1].slice(2)},log.blockNumber]);
  const win=result?words(result):[],winner=addr(log.topics[2]);
  if(win.length<7||addr(win[0])!==winner||addr(win[4])!==wallet||BigInt('0x'+win[6])!==1n)continue;
  const amount=BigInt('0x'+win[3]),collection=addr(win[1]),tokenId=BigInt('0x'+win[2]);
  if(amount<=0n||BigInt(log.data)!==amount)continue;
  const released=receipt.logs.filter(entry=>entry.address===STAKE&&entry.topics[0]===SIG.tokenReleased&&
   entry.topics.length===4&&addr(entry.topics[1])===collection&&BigInt(entry.topics[2])===tokenId&&
   addr(entry.topics[3])===winner&&Number(entry.logIndex)<Number(log.logIndex));
  if(released.length!==1)continue;
  const event=base(log);
  claims.push({...event,id:event.id+':disposal',category:'kept-disposal',raw:amount.toString(),amount:Number(amount)/1e6,
   winId:BigInt(log.topics[1]).toString(),collection,tokenId:tokenId.toString(),releaseId:base(released[0]).id});
 }
 return claims;
}
async function enrichAcquisitions(events,receiptMap,wallet,{rpc:readRpc=rpc,batch:readBatch=batch}={}){
 const out=events.map(e=>({...e}));
 const packs=out.filter(e=>e.category==='pack');
 for(const p of packs.filter(pack=>pack.packKind==='card')){const r=receiptMap.get(p.tx);if(r?.status!=='0x1')continue;const via=(r.logs||[]).filter(l=>l.address.toLowerCase()===p.contract.toLowerCase()&&l.topics[0]===SIG.requestVia&&l.topics.length>=3&&BigInt(l.topics[1]).toString()===p.requestId);p.sourceStatus=via.length?'adapter-source-unresolved':'legacy-receipt';if(via.length===1)p.randomnessSource=addr(via[0].topics[2]);}
 for(const tx of new Set(packs.map(e=>e.tx))){const group=packs.filter(e=>e.tx===tx),e=group[0];
  if(new Set(group.map(e=>e.contract.toLowerCase())).size!==1)continue;
  try{const call=(selector,block)=>['eth_call',[{to:e.contract,data:selector},hex(block)]];
   const isCard=e.packKind==='card';
   const updateSignatures=isCard?[SIG.treasuryUpdated,SIG.feeRecipientUpdated]:[SIG.treasuryUpdated];
   const feeCalls=isCard?[call('0x46904840',e.block-1),call('0x46904840',e.block)]:[];
   const v=await readBatch([call('0x61d027b3',e.block-1),call('0x61d027b3',e.block),call('0x7b9e618d',e.block-1),call('0x7b9e618d',e.block),['eth_getLogs',[{address:e.contract,fromBlock:hex(e.block),toBlock:hex(e.block),topics:[updateSignatures]}]],...feeCalls],true);
   const proof=historicalPayerEvidence(...v.slice(0,5));
   const validWord=x=>typeof x==='string'&&/^0x0{24}[0-9a-fA-F]{40}$/.test(x);
   const fee=validWord(v[5])&&v[5]===v[6]?addr(v[5]):null;
   if(verifyDrawPayments(group,receiptMap.get(tx),wallet,proof.payer,fee))for(const p of group){p.paymentVerified=true;p.paymentProof='finalized USDC transfers; all transaction draws and outgoing payments conserved';}
  }catch{}
 }
 for(const e of out.filter(e=>e.category==='kept')){try{
  const result=await readRpc('eth_call',[{to:e.contract,data:'0x80bfe883'+BigInt(e.winId).toString(16).padStart(64,'0')},hex(e.block)]),v=words(result),r=receiptMap.get(e.tx);
  if(v.length<7||addr(v[0])!==wallet||BigInt('0x'+v[6])!==1n||r?.status!=='0x1')continue;
  const collection=addr(v[1]),tokenId=BigInt('0x'+v[2]).toString();
  const matches=(r.logs||[]).filter(l=>l.address.toLowerCase()===collection&&l.topics[0]===SIG.transfer&&l.topics.length===4&&addr(l.topics[2])===wallet&&BigInt(l.topics[3]).toString()===tokenId);
  if(matches.length!==1)continue;
  Object.assign(e,{collection,tokenId,acquisitionVerified:true,nftReceiptId:base(matches[0]).id});
 }catch{}}
 return out;
}
// Shared with the browser so requests spanning scan pages are joined only after
// deduplication. This is acquisition expenditure, not a current tax-lot basis.
function linkAcquisitionCosts(input){
 const events=[...new Map(input.map(e=>[e.id,e])).values()];
 const sameBox=(a,b)=>a.contract.toLowerCase()===b.contract.toLowerCase();
 return events.filter(e=>e.category==='kept').map(kept=>{
  const out={keptId:kept.id,collection:kept.collection||null,tokenId:kept.tokenId||null,winId:kept.winId,acquisitionCostRaw:null,acquisitionCost:null,costStatus:'unknown',reason:'Missing or ambiguous draw, outcome, payment or NFT acquisition evidence'};
  const wins=events.filter(e=>e.category==='won'&&sameBox(e,kept)&&e.winId===kept.winId);
  if(!kept.acquisitionVerified||wins.length!==1)return out;
  const won=wins[0],draws=events.filter(e=>e.category==='pack'&&e.packKind==='card'&&sameBox(e,won)&&e.requestId===won.requestId);
  const outcomes=events.filter(e=>e.category==='won'&&sameBox(e,won)&&e.requestId===won.requestId);
  const settlements=events.filter(e=>sameBox(e,kept)&&e.winId===kept.winId&&['kept','buyback'].includes(e.category));
  const refunds=events.filter(e=>sameBox(e,won)&&e.requestId===won.requestId&&['refund','refund-evidence','refund-pending'].includes(e.category));
  if(draws.length!==1||outcomes.length!==1||settlements.length!==1||refunds.length||!draws[0].paymentVerified||draws[0].sourceStatus!=='legacy-receipt'||draws[0].block>won.block||won.block>kept.block||won.collection!==kept.collection||won.tokenId!==kept.tokenId)return out;
  const draw=draws[0];return {...out,requestId:won.requestId,drawId:draw.id,acquisitionCostRaw:draw.raw,acquisitionCost:Number(BigInt(draw.raw))/1e6,costStatus:'verified-acquisition',reason:'Unique observed paid request to kept NFT; not proof of uninterrupted ownership or current tax-lot basis'};
 });
}
async function scan(a,refund,from,to){const reg=await registry(),b=reg.boxes,groups=[];for(let i=0;i<b.length;i+=4)groups.push(b.slice(i,i+4).map(x=>x.address));const range={fromBlock:hex(from),toBlock:hex(to)},logs=p=>rpc('eth_getLogs',[{...range,...p}]);const main=(await Promise.all(groups.map(address=>logs({address,topics:[[SIG.draw,SIG.refund,SIG.rescue,SIG.buyback,SIG.tokenBuyback,SIG.kept],null,word(a)]})))).flat();const token=await logs({address:b.filter(x=>x.type==='token').map(x=>x.address),topics:[SIG.tokenDraw,null,null,word(a)]});const won=(await Promise.all(groups.map(address=>logs({address,topics:[SIG.won,null,null,word(a)]})))).flat();const staked=await logs({address:STAKE,topics:[[SIG.staked,SIG.unstaked],null,null,word(a)]});const market=(await logs({address:MARKET,topics:[[SIG.sold,SIG.offer]]})).map(l=>decodeMarket(l,a)).filter(Boolean);const auctionLogs=(await logs({address:MARKET,topics:[SIG.auction]})).filter(l=>BigInt(l.topics[2])!==0n&&BigInt(l.data)>0n);const rewardLogs=(await Promise.all(groups.map(address=>logs({address,topics:[SIG.buyback]})))).flat();const transfers=refund?await logs({address:USDC,topics:[SIG.transfer,word(refund),word(a)]}):[];
const result=await settleWallet(a,[...main,...token,...won,...staked,...transfers],market,auctionLogs,rewardLogs,{rpc,batch},true);
return {from,to,...result,collections:reg.collectionCount,collectionsError:reg.collectionsError};}

function auctionCall(log){
 return ['eth_call',[{to:MARKET,data:'0x571a26a0'+log.topics[1].slice(2)},hex(Number(BigInt(log.blockNumber))-1)]];
}

function auctionSeller(record){
 const values=record?words(record):[];
 return values.length>=8&&BigInt('0x'+values[0])!==0n?addr(values[0]):null;
}

async function settleWallet(wallet,activity,market,auctionLogs,rewardLogs,reader,limit=false){
 const warnings=[],auctions=[];
 if(limit&&auctionLogs.length>60)throw Error('Too many auction events; narrow block range');
 const records=await reader.batch(auctionLogs.map(auctionCall),true);
 auctionLogs.forEach((log,i)=>{
  const record=records[i],seller=auctionSeller(record),auctionId=BigInt(log.topics[1]).toString();
  if(!seller){warnings.push('Auction '+auctionId+' seller unavailable at settlement block; auction coverage incomplete');return;}
  const buyer=addr(log.topics[2]);
  if(seller!==wallet&&buyer!==wallet)return;
  const values=words(record),currency=addr(values[3]),raw=BigInt(log.data).toString();
  auctions.push({...base(log),category:seller===buyer?'selfTrade':seller===wallet?'saleGross':'purchaseGross',collection:addr(values[1]),tokenId:BigInt('0x'+values[2]).toString(),seller,buyer,currency,raw:currency===USDC?raw:null,amount:currency===USDC?Number(raw)/1e6:null,auctionId,auction:true});
 });
 let events=activity.map(decode).filter(Boolean).concat(market,auctions,rewardLogs.flatMap(log=>decodeReward(log,wallet)));
 const saleTxs=[...new Set([...market,...auctions].filter(e=>e.category==='saleGross'&&e.currency===USDC).map(e=>e.tx))];
 const dispositions=reader.dispositionLogs??[];
 const evidenceTxs=[...new Set([...events.filter(e=>['refund','staking','buyback-claim','pack','kept'].includes(e.category)).map(e=>e.tx),
  ...dispositions.map(log=>log.transactionHash)])];
 if(limit&&saleTxs.length>40)throw Error('Too many sales to reconcile; narrow block range');
 if(limit&&evidenceTxs.length>80)throw Error('Too many payout/acquisition transactions to reconcile; narrow block range');
 const txs=[...new Set([...saleTxs,...evidenceTxs])];
 const receipts=await reader.batch(txs.map(tx=>['eth_getTransactionReceipt',[tx]]),true);
 const receiptMap=new Map(txs.map((tx,i)=>[tx,receipts[i]]));
 for(const tx of saleTxs){
  const sales=events.filter(e=>e.tx===tx&&e.category==='saleGross'),receipt=receiptMap.get(tx);
  if(!receipt||receipt.status!=='0x1'){warnings.push('Sale receipt missing or failed '+tx);continue;}
  const payments=receipt.logs.filter(l=>l.address.toLowerCase()===USDC&&l.topics[0]===SIG.transfer&&addr(l.topics[1])===MARKET&&addr(l.topics[2])===wallet);
  if(!payments.length){warnings.push('Sale payout not confirmed '+tx);continue;}
  payments.forEach(l=>events.push({...base(l),category:'sales',raw:BigInt(l.data).toString(),amount:Number(BigInt(l.data))/1e6,reconciled:true,saleIds:sales.map(e=>e.id)}));
 }
 events=await enrichAcquisitions(events,receiptMap,wallet,reader);
 events.push(...await keptDisposals(dispositions,receiptMap,wallet,reader.rpc));
 events=await resolveRefundPayers(events,reader.batch);
 events=reconcileRefunds(events,receiptMap,wallet);
 const pending=events.filter(e=>e.category==='refund-pending');
 const pendingBuybacks=events.filter(e=>e.category==='buyback-claim-pending');
 const pendingRewards=events.filter(e=>e.category==='staking-pending');
 if(pendingBuybacks.length)warnings.push(pendingBuybacks.length+' winner buyback records unresolved; excluded from inflows');
 if(pendingRewards.length)warnings.push(pendingRewards.length+' staking reward records unresolved; excluded from inflows');
 if(pending.length)warnings.push(pending.length+' refund records pending unique receipt attribution; excluded from confirmed inflows');
 return {events,warnings};
}
async function holdings(wallet,assets,block,{rpc:readRpc=rpc,batch:readBatch=batch}={},limit=40){
 const unique=[...new Map(assets.map(x=>[x.collection.toLowerCase()+':'+x.tokenId,{collection:x.collection.toLowerCase(),tokenId:x.tokenId}])).values()];
 if(unique.length>limit)throw Error('Maximum '+limit+' assets per holdings page');
 if(unique.some(x=>!valid(x.collection)||!/^\d+$/.test(x.tokenId)))throw Error('Invalid NFT');
 if(!unique.length)return [];
 const at=hex(block),collections=[...new Set(unique.map(asset=>asset.collection))];
 const call=(to,data)=>['eth_call',[{to,data},at]];
 const owners=unique.map(asset=>call(asset.collection,'0x6352211e'+BigInt(asset.tokenId).toString(16).padStart(64,'0')));
 const stakers=unique.map(asset=>call(STAKE,'0x56a0fd45'+word(asset.collection).slice(2)+BigInt(asset.tokenId).toString(16).padStart(64,'0')));
 const prices=collections.map(collection=>call(STAKE,'0xee687063'+word(collection).slice(2)));
 const oracleDecimals=async()=>{
  try{
   const oracle=addr(await readRpc(...call(STAKE,'0x2630c12f')));
   return Number(BigInt(await readRpc(...call(oracle,'0x05300b28'))));
  }catch{return null;}
 };
 const [results,decimals]=await Promise.all([readBatch([...owners,...stakers,...prices],true),oracleDecimals()]);
 const count=unique.length;
 const priceByCollection=new Map(collections.map((collection,index)=>[collection,results[count*2+index]]));
 return unique.map((asset,i)=>{
  const owner=results[i]?addr(results[i]):null,staker=results[count+i]?addr(results[count+i]):null;
  const price=words(priceByCollection.get(asset.collection)??'0x');
  const referenceValue=decimals===6&&price.length>=2&&BigInt('0x'+price[0])>0n?Number(BigInt('0x'+price[0]))/1e6:null;
  return {...asset,owner,staker,status:owner===wallet?'wallet':staker===wallet?'staked':owner&&staker?'not-held':'unknown',
   referenceValue,oracleDecimals:decimals,oracleTimestamp:price.length>=2?Number(BigInt('0x'+price[1])):null,block};
 });
}
export default {async fetch(request){try{const u=new URL(request.url);if(u.pathname==='/api/init'){const [block,reg]=await Promise.all([rpc('eth_blockNumber',[]),registry()]);return Response.json({head:Number(BigInt(block))-20,start:50636771,contracts:reg.boxes,collections:reg.collectionCount,collectionsError:reg.collectionsError,rpc:RPC,chainId:8453,asOf:new Date().toISOString()});}if(u.pathname==='/api/holdings'&&request.method==='POST'){const body=await request.json();if(!valid(body.wallet)||!Number.isSafeInteger(body.block)||!Array.isArray(body.assets))return Response.json({error:'Invalid holdings request'},{status:400});return Response.json({assets:await holdings(body.wallet.toLowerCase(),body.assets,body.block)});}if(u.pathname==='/api/scan'){const a=(u.searchParams.get('wallet')||'').toLowerCase(),refund=(u.searchParams.get('refund')||'').toLowerCase();if(!valid(a)||refund&&!valid(refund))return Response.json({error:'Invalid wallet or refund address'},{status:400});const from=Number(u.searchParams.get('from')),to=Number(u.searchParams.get('to'));if(!Number.isSafeInteger(from)||!Number.isSafeInteger(to)||from<50636771||to<from||to-from>49999)return Response.json({error:'Invalid block range, maximum 50,000 blocks'},{status:400});return Response.json(await scan(a,refund,from,to));}if(u.pathname!=='/')return new Response('Not found',{status:404});return new Response(HTML,{headers:{'content-type':'text/html;charset=utf-8','content-security-policy':"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'"}});}catch(e){return Response.json({error:e.message||'Data source unavailable. No zero values substituted.'},{status:502});}}};
const HTML=renderWalletReport(linkAcquisitionCosts);
export {addr,auctionCall,auctionSeller,boxes,FACTORIES,FACTORY_DEPLOYMENTS,hex,holdings,MARKET,rpcRequest,settleWallet,STAKE,USDC,valid,word,words,decode,decodeMarket,SIG,reconcileRefunds,historicalPayerEvidence,decodeReward,verifyDrawPayments,linkAcquisitionCosts};
