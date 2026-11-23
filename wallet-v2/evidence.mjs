import { address, asAddress, eventId, word, assetKey, TRANSFER, USDC } from './model.mjs';
const DRAW_VIA = '0xba25fefcb40ae654f130e3be6b73de7f0ccf2b8441ec58a2ad8366d3be8d2e54';
function mentionsWallet(log, wallet) {
  const account = word(wallet);
  return log.topics?.some(topic => topic.toLowerCase() === account) || log.data?.toLowerCase().includes(account.slice(2));
}
function relevantAssets(ledger) {
  return new Set([...ledger.events.filter(event => event.collection && event.tokenId !== undefined).map(event => assetKey(event.collection, event.tokenId)),
    ...ledger.events.filter(event => event.category === 'UpgradeRequested').flatMap(event => [assetKey(event.stakeCollection, event.stakeTokenId), assetKey(event.targetCollection, event.targetTokenId)])]);
}
export function receiptContext(ledger, knownAssetsOnly = false) {
  return { upgrades: new Set(ledger.catalog.filter(pool => pool.kind === 'upgrade').map(pool => pool.address)),
    assets: knownAssetsOnly ? relevantAssets(ledger) : null };
}
export function compactReceipt(receipt, ledger, { knownAssetsOnly = false, context } = {}) {
  const { upgrades, assets } = context || receiptContext(ledger, knownAssetsOnly);
  return { proofOnly: true, transactionHash: receipt.transactionHash, blockHash: receipt.blockHash,
    blockNumber: receipt.blockNumber, status: receipt.status,
    logs: receipt.logs.filter(log => mentionsWallet(log, ledger.wallet) || upgrades.has(log.address.toLowerCase()) || log.topics[0] === DRAW_VIA ||
      log.topics[0] === TRANSFER && log.topics.length === 4 && (!assets || assets.has(assetKey(log.address, BigInt(log.topics[3]).toString())))) };
}
export function pruneTransfers(ledger) {
  const assets = relevantAssets(ledger);
  ledger.transfers = ledger.transfers.filter(transfer => transfer.walletRelated || transfer.from === ledger.wallet || transfer.to === ledger.wallet ||
    transfer.kind === 'nft' && assets.has(assetKey(transfer.collection, transfer.tokenId)));
}
function transferRecord(log, wallet) {
  if (log.topics?.[0] !== TRANSFER || ![3, 4].includes(log.topics.length) || !mentionsWallet(log, wallet)) return null;
  const collection = address(log.address);
  if (log.topics.length === 3 && collection !== USDC) return null;
  return { id: eventId(log.transactionHash, log.logIndex), tx: log.transactionHash.toLowerCase(), block: Number(log.blockNumber),
    logIndex: Number(log.logIndex), collection, from: asAddress(log.topics[1]), to: asAddress(log.topics[2]),
    ...(log.topics.length === 4 ? { kind: 'nft', tokenId: BigInt(log.topics[3]).toString() } : { kind: 'usdc', raw: BigInt(log.data).toString() }),
    walletRelated: true };
}
export function observeEvidence(reader, currentLedger) {
  const observed = new Map();
  const remember = (method, params, result) => {
    const ledger = currentLedger();
    if (method === 'eth_getTransactionReceipt' && result) ledger.receipts[params[0].toLowerCase()] = compactReceipt(result, ledger);
    const logs = method === 'eth_getLogs' && Array.isArray(result) ? result : method === 'eth_getTransactionReceipt' ? result?.logs : null;
    for (const log of logs || []) {
      const transfer = transferRecord(log, ledger.wallet);
      if (transfer) observed.set(transfer.id, transfer);
    }
    // Return the actual unmodified RPC response to Gavin, never a proof-only stored receipt.
    return result;
  };
  return { ...reader,
    rpc: async (method, params) => remember(method, params, await reader.rpc(method, params)),
    batch: async (calls, partial = false) => {
      const results = await reader.batch(calls, partial);
      return results.map((result, index) => remember(calls[index][0], calls[index][1], result));
    },
    transferEvidence(events) {
      const txs = new Set(events.map(event => event.tx));
      return [...observed.values()].filter(transfer => txs.has(transfer.tx));
    },
  };
}
