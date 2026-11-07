import { hex } from './index.js';
import { alchemy } from './history/chain.js';
import { campaignPayoutsInRange } from './history/campaign-payouts.js';
import { withWalletLock } from './history/refresh.js';
import { addWalletTotals, summarizeWalletEvents } from './report/accounting.js';
import { directWalletReport, finalizedWalletBlock, WALLET_HISTORY_START } from './wallet-direct.js';

const CACHE_VERSION = 3;

async function stateFor(sql, wallet) {
  const [row] = await sql`SELECT revision, snapshot, draft FROM wallet_cashflow_cache WHERE wallet = ${wallet}`;
  return row || { revision: 0, snapshot: null, draft: null };
}

async function initialize(sql) {
  await sql.transaction([
    sql`SELECT pg_advisory_xact_lock(8453, 20261108)`,
    sql`CREATE TABLE IF NOT EXISTS wallet_cashflow_cache (
      wallet text PRIMARY KEY, revision integer NOT NULL, snapshot jsonb, draft jsonb
    )`,
  ]);
}

async function save(sql, wallet, current, snapshot, draft) {
  const rows = await sql`INSERT INTO wallet_cashflow_cache (wallet, revision, snapshot, draft)
    VALUES (${wallet}, ${current.revision + 1}, ${JSON.stringify(snapshot)}::jsonb, ${JSON.stringify(draft)}::jsonb)
    ON CONFLICT (wallet) DO UPDATE
      SET revision = excluded.revision, snapshot = excluded.snapshot, draft = excluded.draft
      WHERE wallet_cashflow_cache.revision = ${current.revision}
    RETURNING revision`;
  if (rows.length !== 1) throw Error('Wallet report was advanced by another request');
}

function usable(snapshot) {
  return snapshot?.version === CACHE_VERSION ? snapshot : null;
}

function canRead(snapshot, afterBlock) {
  return snapshot && (afterBlock === undefined || snapshot.through > afterBlock);
}

function reconcileCampaign(snapshot, wallet) {
  const campaignPayouts = campaignPayoutsInRange(wallet, snapshot.start, snapshot.through);
  const { compensation, campaignPrizes, campaignOther } = summarizeWalletEvents(campaignPayouts);
  const totals = { ...snapshot.totals, compensation, campaignPrizes, campaignOther };
  return { snapshot: { ...snapshot, totals }, campaignPayouts };
}

function fromCache(saved, wallet, usage = { units: 0 }) {
  const { snapshot, campaignPayouts } = reconcileCampaign(saved, wallet);
  return { ready: true, cached: true, snapshot: { ...snapshot, campaignPayouts }, usage };
}

async function begin(reader, previous) {
  const head = await finalizedWalletBlock(reader);
  const target = Number(head.number);
  if (previous) {
    const saved = previous.through === target ? head : await reader.rpc('eth_getBlockByNumber', [hex(previous.through), false]);
    if (target < previous.through || saved?.hash !== previous.blockHash) {
      throw Error('Saved wallet block hash no longer matches finalized Base history');
    }
    if (target === previous.through) return null;
  }
  return {
    version: CACHE_VERSION, start: WALLET_HISTORY_START, target, blockHash: head.hash,
    asOf: new Date(Number(head.timestamp) * 1_000).toISOString(),
    through: previous?.through ?? WALLET_HISTORY_START - 1,
    totals: previous?.totals ?? {},
  };
}

export async function walletCachePage(sql, wallet, afterBlock) {
  const first = await stateFor(sql, wallet).catch(error => {
    if (error.code === '42P01') return null;
    throw error;
  });
  const snapshot = usable(first?.snapshot);
  if (canRead(snapshot, afterBlock)) return fromCache(snapshot, wallet);
  const result = await withWalletLock(wallet, async assertLock => {
    if (!first) await initialize(sql);
    const current = await stateFor(sql, wallet);
    const saved = usable(current.snapshot);
    if (canRead(saved, afterBlock)) return fromCache(saved, wallet);
    if (afterBlock !== undefined && (!saved || afterBlock !== saved.through)) {
      throw Error('Wallet refresh must start from its current saved checkpoint');
    }
    const reader = alchemy({ maxUnits: 120_000, maxMs: 240_000, beforeRequest: assertLock });
    const draft = usable(current.draft) || await begin(reader, saved);
    if (!draft) return fromCache(saved, wallet, reader.stats);
    const page = await directWalletReport(wallet, draft.through + 1, draft.target, reader);
    const { snapshot: next, campaignPayouts } = reconcileCampaign({
      ...draft, through: page.to,
      totals: addWalletTotals(draft.totals, summarizeWalletEvents(page.events)),
    }, wallet);
    const ready = page.to === draft.target;
    assertLock();
    await save(sql, wallet, current, ready ? next : saved, ready ? null : next);
    return {
      ready, cached: false, snapshot: ready ? { ...next, campaignPayouts } : null,
      progress: { from: WALLET_HISTORY_START, through: next.through, target: next.target, asOf: next.asOf },
      page, usage: reader.stats,
    };
  });
  return result ?? {
    ready: false, waiting: true, usage: { units: 0 },
    progress: first?.draft ? { from: WALLET_HISTORY_START, through: first.draft.through, target: first.draft.target, asOf: first.draft.asOf } : null,
  };
}
