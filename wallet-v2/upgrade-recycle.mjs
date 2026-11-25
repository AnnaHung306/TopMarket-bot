import { address, asAddress, eventId, hex, TRANSFER, USDC } from './model.mjs';

// A WinRecycled amount becomes income only after the historical token/treasury
// and the matching preceding payment in the successful receipt agree.
export async function verifyUpgradeRecycles(reader, events, pool) {
  const recycled = events.filter(event => event.category === 'WinRecycled');
  if (!recycled.length) return;
  const calls = recycled.flatMap(event => ['settlementToken', 'treasury'].map(name =>
    ['eth_call', [{ to: pool.address, data: pool.definition.selectors[name] }, hex(event.block)]]));
  const configuration = await reader.batch(calls);
  const txs = [...new Set(recycled.map(event => event.tx))];
  const receipts = await reader.batch(txs.map(tx => ['eth_getTransactionReceipt', [tx]]));
  const byTx = new Map(txs.map((tx, index) => [tx, receipts[index]])), used = new Set();
  for (const [index, event] of recycled.entries()) {
    const receipt = byTx.get(event.tx);
    if (!receipt || receipt.status !== '0x1') throw Error('缺少成功升級回購交易回執');
    const token = asAddress(configuration[index * 2]), treasury = asAddress(configuration[index * 2 + 1]);
    event.settlementToken = token; event.treasury = treasury;
    if (token !== USDC) { event.paymentReason = '升級回購使用非 USDC 代幣，未混入 USDC 收益'; continue; }
    const prior = receipt.logs.filter(log => address(log.address) === pool.address && log.topics[0] === pool.definition.topics.WinRecycled &&
      Number(log.logIndex) < event.logIndex).reduce((last, log) => Math.max(last, Number(log.logIndex)), -1);
    const payments = receipt.logs.filter(log => address(log.address) === token && log.topics.length === 3 && log.topics[0] === TRANSFER &&
      asAddress(log.topics[1]) === treasury && asAddress(log.topics[2]) === event.player &&
      Number(log.logIndex) > prior && Number(log.logIndex) < event.logIndex && BigInt(log.data).toString() === event.recycleRaw);
    if (payments.length !== 1 || used.has(eventId(event.tx, payments[0].logIndex))) {
      event.paymentReason = '升級回購未與唯一 USDC 入帳核對'; continue;
    }
    event.recycleTransferId = eventId(event.tx, payments[0].logIndex);
    used.add(event.recycleTransferId); event.recycleVerified = true; event.raw = event.recycleRaw;
  }
}
