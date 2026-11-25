import test from 'node:test';
import assert from 'node:assert/strict';
import { STAKE } from '../../worker/index.js';
import { RAFFLE_CONTRACT } from '../../worker/history/raffle.js';
import { assetKey, word, hex, TRANSFER } from '../model.mjs';
import { updateCardValues, cardValuesFresh, holdingsReferenceValue, raffleReferenceValue } from '../card-values.mjs';
import { buildReport, textReport } from '../report.mjs';
import { htmlReport, csvReport } from '../exports.mjs';

// Synthetic transport fixtures test ABI/evidence rules; the review PNG uses real Alchemy evidence.
const wallet = '0x' + 'a'.repeat(40), other = '0x' + 'b'.repeat(40), collection = '0x' + 'c'.repeat(40);
const oracle = '0x' + 'd'.repeat(40), tx = '0x' + '1'.repeat(64), zero = '0x' + '0'.repeat(40);
const claimTopic = '0xbfb36529287d5a1dcbfbbc958f0a7337a1f5bca269edc737da0be1be702f2251';
function setup(options = {}) {
  const prize = { id: 'prize', category: 'raffle-card', activity: 'raffle', tx, block: 10, logIndex: 2, requestId: '7', timestamp: 1794459673 };
  const transfer = (tokenId, from, to, index) => ({ id: 'transfer-' + index, tx, block: 10, logIndex: index, timestamp: prize.timestamp,
    collection, tokenId, from, to, kind: 'nft', walletRelated: true });
  const ledger = { wallet, events: [prize, { id: 'staking', legacyId: tx + ':0x4', tx, block: 10, logIndex: 4,
    timestamp: prize.timestamp, category: 'staked', collection, tokenId: '2' }],
    transfers: [transfer('2', other, wallet, 0), transfer('2', wallet, STAKE, 3)],
    catalog: [], cards: {}, warnings: [], receipts: {}, blocks: { 10: { hash: 'claim-hash' } },
    coverage: { gavin: { status: 'verified', complete: true, through: 20, blockHash: 'snapshot-hash', asOf: '2026-11-25T08:03:22Z' } } };
  const receipt = { status: '0x1', blockNumber: '0xa', blockHash: 'claim-hash', logs: [
    { address: collection, topics: [TRANSFER, word(RAFFLE_CONTRACT), word(wallet), word('0x1')], logIndex: '0x1' },
    { address: RAFFLE_CONTRACT, topics: [claimTopic, word('0x7'), word(wallet)], logIndex: '0x2' },
  ] };
  const calls = [];
  const rpc = async (method, params) => {
    calls.push([method, params]);
    if (options.failure) throw Error('transport unavailable');
    if (method === 'eth_getTransactionReceipt') return receipt;
    const data = params[0].data;
    if (data === '0x2630c12f') return word(oracle);
    if (data === '0x05300b28') return word(hex(options.decimals ?? 6));
    const token = BigInt('0x' + data.slice(-64)).toString();
    if (data.startsWith('0x6352211e')) return options.unknownOwner ? null : word(token === '2' ? STAKE : options.prizeHeld ? wallet : other);
    if (data.startsWith('0x56a0fd45')) return word(token === '2' ? wallet : zero);
    assert.ok(data.startsWith('0xfc3d545d'));
    return options.missingQuote ? null : word(hex(token === '1' ? 7430000000n : 5000000n)) + word(hex(1794459673)).slice(2);
  };
  return { ledger, prize, receipt, calls, reader: { rpc, batch: async requests => Promise.all(requests.map(([m, p]) => rpc(m, p))) } };
}

test('claim-block prize and snapshot-block staking values use USDC oracle ABI, never acquisition cost', async () => {
  const h = setup(); await updateCardValues(h.reader, h.ledger);
  assert.equal(raffleReferenceValue(h.ledger, [h.prize]), '7430000000');
  assert.equal(holdingsReferenceValue(h.ledger), '5000000');
  assert.equal(h.ledger.cardValues.prizes.prize.block, 10);
  assert.equal(h.ledger.cardValues.holdings[assetKey(collection, '2')].block, 20);
  assert.equal(h.ledger.cardValues.holdings[assetKey(collection, '2')].status, 'staked');
  assert.ok(cardValuesFresh(h.ledger));
  const before = buildReport({ ...h.ledger, cardValues: undefined });
  const report = buildReport(h.ledger, { detail: 'detail' });
  assert.deepEqual(report.cash, before.cash);
  assert.equal(report.cash.netRaw, '0');
  assert.equal(report.siteSummary.find(row => row.key === 'raffleIncome').raw, '7430000000');
  assert.equal(report.holdingsSummary.valueRaw, '5000000');
  assert.match(textReport(report), /奪寶收入（含卡片估值）：7,430\.00/);
  assert.match(textReport(report), /參考價值：5\.00 USDC/);
  assert.doesNotMatch(textReport(report), /\d 張卡|錢包 \d 張/);
  const html = await htmlReport(report);
  assert.match(html, /data-key="holdingsValue" data-raw="5000000"/);
  assert.doesNotMatch(html, /\d 張卡|錢包 \d 張/);
});

test('historical prize valuation persists, while held assets reprice at the new snapshot', async () => {
  const h = setup({ prizeHeld: true }); await updateCardValues(h.reader, h.ledger);
  assert.equal(holdingsReferenceValue(h.ledger), '7435000000');
  assert.match(csvReport(buildReport(h.ledger)), /"card_reference_raw"/);
  h.calls.length = 0; h.ledger.coverage.gavin.through = 21;
  assert.equal(cardValuesFresh(h.ledger), false);
  await updateCardValues(h.reader, h.ledger);
  assert.equal(h.calls.filter(([method]) => method === 'eth_getTransactionReceipt').length, 0);
  assert.ok(h.calls.every(([, params]) => params[1] === '0x15'));
  h.ledger.transfers.push({ ...h.ledger.transfers[0], id: 'new-evidence' });
  assert.equal(cardValuesFresh(h.ledger), false);
});

test('NFT estimates do not inflate cash net and prizes respect the selected date range', async () => {
  const h = setup(); await updateCardValues(h.reader, h.ledger);
  const report = buildReport(h.ledger, { period: 'custom', from: '2026-11-25', to: '2026-11-25' });
  assert.equal(report.siteSummary.find(row => row.key === 'raffleIncome').raw, '0');
  assert.equal(report.holdingsSummary.valueRaw, '5000000');
  assert.equal(report.cash.netRaw, '0');
  h.ledger.events.push({ id: 'real-payout', tx, block: 11, logIndex: 9, timestamp: h.prize.timestamp + 1,
    category: 'raffle-income', activity: 'raffle', raw: '100000000' });
  const paid = buildReport(h.ledger);
  assert.equal(paid.cash.netRaw, '100000000');
  assert.equal(paid.siteSummary.find(row => row.key === 'raffleIncome').raw, '7530000000');
});

test('unverified decimals, missing quotes and unknown ownership remain unknown', async () => {
  for (const options of [{ decimals: 18 }, { missingQuote: true }, { unknownOwner: true }]) {
    const h = setup(options); await updateCardValues(h.reader, h.ledger);
    assert.equal(holdingsReferenceValue(h.ledger), null);
    assert.ok(cardValuesFresh(h.ledger), 'remember an attempted quote at the same snapshot');
    if (!options.unknownOwner) assert.equal(raffleReferenceValue(h.ledger, [h.prize]), null);
  }
  const h = setup({ failure: true });
  await assert.rejects(updateCardValues(h.reader, h.ledger), /transport unavailable/);
  assert.equal(h.ledger.cardValues, undefined);
});

test('ambiguous prize receipts remain unknown rather than guessing the NFT or zero', async () => {
  const h = setup(); h.receipt.logs.unshift({ ...h.receipt.logs[0], topics: [TRANSFER, word(RAFFLE_CONTRACT), word(wallet), word('0x3')] });
  await updateCardValues(h.reader, h.ledger);
  assert.equal(raffleReferenceValue(h.ledger, [h.prize]), null);
  assert.equal(holdingsReferenceValue(h.ledger), null);
});

test('ownerOf revert excludes a burned prize only with complete transfer history and a burn event', async () => {
  const h = setup();
  const rpc = h.reader.rpc;
  h.reader.batch = async calls => Promise.all(calls.map(([method, params]) =>
    params[0].data.startsWith('0x6352211e') && BigInt('0x' + params[0].data.slice(-64)) === 1n ? null : rpc(method, params)));
  h.ledger.transfers.push({ id: 'burn-proof', tx, block: 11, logIndex: 9, timestamp: h.prize.timestamp + 1,
    kind: 'nft', collection, tokenId: '1', from: wallet, to: zero });
  h.ledger.ownershipCoverage = { [collection]: 20 };
  await updateCardValues(h.reader, h.ledger);
  assert.equal(holdingsReferenceValue(h.ledger), '5000000');
  assert.equal(h.ledger.cardValues.holdings[assetKey(collection, '1')].burnTransferId, 'burn-proof');
  delete h.ledger.ownershipCoverage;
  await updateCardValues(h.reader, h.ledger);
  assert.equal(holdingsReferenceValue(h.ledger), null);
});
