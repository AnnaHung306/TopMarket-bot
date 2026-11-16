import { SIG, USDC, word } from '../index.js';
import { getFilteredLogs } from './chain.js';

const raffle = '0xcbc5aa58084aaae6a283101011e6001d7ba7783a';
const deployment = 51472799;
// ShareRaffle proxy and verified event ABI on Base.
const sharesBought = '0x846b419737e4796baa1e2f5ea7b76571d256eac56d566c44767ee2c49ad7f292';
const boughtBack = '0xd04674a07f53a70d82fa6f13a59443dcc4ccd58f8b504604dd61e5982c91f9e3';
const refundClaimed = '0xf3f402280ef0a7905e124aa621b65eaeb2725c343e8b36d398ed78c29daf285c';
const prizeClaimed = '0xbfb36529287d5a1dcbfbbc958f0a7337a1f5bca269edc737da0be1be702f2251';
export { raffle as RAFFLE_CONTRACT, sharesBought as RAFFLE_SHARES_BOUGHT };
const categories = {
  [sharesBought]: 'raffle-participation',
  [boughtBack]: 'raffle-income',
  [refundClaimed]: 'raffle-refund',
  [prizeClaimed]: 'raffle-card',
};

export function readRaffleLogs(reader, wallet, from, to) {
  const start = Math.max(deployment, from);
  if (start > to) return Promise.resolve([]);
  return getFilteredLogs(reader, { address: raffle, topics: [Object.keys(categories), null, word(wallet)] }, start, to);
}

export function raffleEvents(wallet, logs, cash) {
  const participant = word(wallet), contract = word(raffle);
  const cashByTx = new Map();
  for (const log of cash) {
    const [, from, to] = log.topics;
    if (log.address !== USDC || log.topics[0] !== SIG.transfer || log.topics.length !== 3 ||
      !((from === participant && to === contract) || (from === contract && to === participant))) continue;
    if (!cashByTx.has(log.transactionHash)) cashByTx.set(log.transactionHash, []);
    cashByTx.get(log.transactionHash).push(log);
  }

  const previousByTx = new Map();
  const evidence = [...logs].sort((a, b) => Number(a.blockNumber) - Number(b.blockNumber) || Number(a.logIndex) - Number(b.logIndex));
  return evidence.flatMap(log => {
    const signature = log.topics[0], category = categories[signature];
    if (!category || log.address !== raffle || log.topics[2] !== participant) return [];
    const index = Number(log.logIndex), tx = log.transactionHash;
    const previous = previousByTx.get(tx) ?? -1;
    previousByTx.set(tx, index);
    const entry = (proof, raw) => ({
      id: tx + ':' + proof.logIndex, tx, block: Number(log.blockNumber), logIndex: Number(proof.logIndex),
      contract: raffle, category, requestId: BigInt(log.topics[1]).toString(),
      raw: raw?.toString() ?? null, amount: raw === null ? null : Number(raw) / 1e6,
    });
    if (signature === prizeClaimed) return [entry(log, null)];

    const incomingAmount = signature === sharesBought ? null : BigInt(log.data);
    const matching = (cashByTx.get(tx) ?? []).filter(transfer => {
      const transferIndex = Number(transfer.logIndex);
      // SharesBought is emitted immediately after the USDC transfer.
      if (incomingAmount === null) return transfer.topics[1] === participant && transferIndex === index - 1;
      return transfer.topics[1] === contract && transferIndex > previous && transferIndex < index && BigInt(transfer.data) === incomingAmount;
    });
    return matching.length === 1 ? [entry(matching[0], BigInt(matching[0].data))] : [];
  });
}

export async function readRaffleHistory(reader, wallet, from, through) {
  const logs = await readRaffleLogs(reader, wallet, from, through);
  const tokenTransfers = (events, sender, recipient) => {
    if (!events.length) return Promise.resolve([]);
    let first = Infinity, last = 0;
    for (const event of events) {
      const block = Number(event.blockNumber);
      first = Math.min(first, block);
      last = Math.max(last, block);
    }
    return getFilteredLogs(reader, { address: USDC, topics: [SIG.transfer, word(sender), word(recipient)] }, first, last);
  };
  const [paid, received] = await Promise.all([
    tokenTransfers(logs.filter(log => log.topics[0] === sharesBought), wallet, raffle),
    tokenTransfers(logs.filter(log => [boughtBack, refundClaimed].includes(log.topics[0])), raffle, wallet),
  ]);
  return raffleEvents(wallet, logs, [...paid, ...received]);
}
