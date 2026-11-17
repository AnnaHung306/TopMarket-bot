import { hex } from './index.js';
import { alchemy } from './history/chain.js';
import { campaignPayoutsInRange } from './history/campaign-payouts.js';
import { readRaffleHistory } from './history/raffle.js';
import { withWalletLock } from './history/refresh.js';
import { addWalletTotals, summarizeWalletEvents } from './report/accounting.js';
import { directWalletReportBatch, finalizedWalletBlock, WALLET_HISTORY_START, WALLET_PARALLEL_PAGES } from './wallet-direct.js';

const CACHE_VERSION = 3;
const LEGACY_CACHE_VERSION = 2;
const MAX_CACHE_JSON_BYTES = 32_768;
const MAX_CACHE_ROWS = 1_000;
let schemaReady;

async function stateFor(sql, wallet) {
  const [row] = await sql`SELECT revision, snapshot, draft FROM wallet_cashflow_cache WHERE wallet = ${wallet}`;
  return row || { revision: 0, snapshot: null, draft: null };
}

async function initialize(sql) {
  await sql.transaction([
    sql`SELECT pg_advisory_xact_lock(8453, 20261108)`,
    sql`CREATE TABLE IF NOT EXISTS wallet_cashflow_cache (
      wallet text PRIMARY KEY, revision integer NOT NULL, snapshot jsonb, draft jsonb,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`,
    sql`ALTER TABLE wallet_cashflow_cache ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()`,
    sql`CREATE INDEX IF NOT EXISTS wallet_cashflow_cache_updated_at_idx ON wallet_cashflow_cache (updated_at)`,
  ]);
}

function ensureSchema(sql) {
  schemaReady ??= initialize(sql).catch(error => { schemaReady = undefined; throw error; });
  return schemaReady;
}

async function save(sql, wallet, current, snapshot, draft) {
  const snapshotJson = JSON.stringify(snapshot), draftJson = JSON.stringify(draft);
  if (new TextEncoder().encode(snapshotJson).length > MAX_CACHE_JSON_BYTES ||
      new TextEncoder().encode(draftJson).length > MAX_CACHE_JSON_BYTES) throw Error('Wallet cache row size limit reached');
  await ensureSchema(sql);
  const rows = await sql`INSERT INTO wallet_cashflow_cache (wallet, revision, snapshot, draft)
    VALUES (${wallet}, ${current.revision + 1}, ${snapshotJson}::jsonb, ${draftJson}::jsonb)
    ON CONFLICT (wallet) DO UPDATE
      SET revision = excluded.revision, snapshot = excluded.snapshot, draft = excluded.draft, updated_at = now()
      WHERE wallet_cashflow_cache.revision = ${current.revision}
    RETURNING revision`;
  if (rows.length !== 1) throw Error('Wallet report was advanced by another request');
  await sql`DELETE FROM wallet_cashflow_cache WHERE wallet IN (
    SELECT wallet FROM wallet_cashflow_cache ORDER BY updated_at DESC, wallet OFFSET ${MAX_CACHE_ROWS}
  )`;
}

function readable(snapshot) {
  return snapshot?.version === CACHE_VERSION || snapshot?.version === LEGACY_CACHE_VERSION ? snapshot : null;
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
  if (saved.version === LEGACY_CACHE_VERSION) {
    return { ready: true, cached: true, snapshot: { ...saved, rebuildRequired: true }, usage };
  }
  const { snapshot, campaignPayouts } = reconcileCampaign(saved, wallet);
  return { ready: true, cached: true, snapshot: { ...snapshot, campaignPayouts }, usage };
}

async function fillRaffleTotals(snapshot, wallet, reader) {
  if (Object.hasOwn(snapshot.totals, 'raffleParticipation')) return snapshot;
  const events = await readRaffleHistory(reader, wallet, snapshot.start, snapshot.through);
  const { raffleParticipation, raffleIncome, raffleRefund, raffleCards } = summarizeWalletEvents(events);
  return { ...snapshot, totals: { ...snapshot.totals, raffleParticipation, raffleIncome, raffleRefund, raffleCards } };
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

export async function readWalletSnapshot(sql, wallet) {
  const state = await stateFor(sql, wallet).catch(error => {
    if (error.code === '42P01') return null;
    throw error;
  });
  const snapshot = readable(state?.snapshot);
  return snapshot ? fromCache(snapshot, wallet).snapshot : null;
}

export async function readWalletProgress(sql, wallet) {
  const state = await stateFor(sql, wallet).catch(error => {
    if (error.code === '42P01') return null;
    throw error;
  });
  const draft = state?.draft?.version === CACHE_VERSION ? state.draft : null;
  return draft ? { from: draft.start, through: draft.through, target: draft.target } : null;
}

export async function walletCachePage(sql, wallet, afterBlock, options = {}) {
  const first = await stateFor(sql, wallet).catch(error => {
    if (error.code === '42P01') return null;
    throw error;
  });
  const snapshot = readable(first?.snapshot);
  if (canRead(snapshot, afterBlock)) return fromCache(snapshot, wallet);
  const result = await withWalletLock(wallet, async assertLock => {
    if (!first) await ensureSchema(sql);
    const current = await stateFor(sql, wallet);
    const saved = readable(current.snapshot);
    if (canRead(saved, afterBlock)) return fromCache(saved, wallet);
    if (afterBlock !== undefined && (!saved || afterBlock !== saved.through)) {
      throw Error('Wallet refresh must start from its current saved checkpoint');
    }
    const reader = alchemy({
      maxUnits: options.maxUnits ?? WALLET_PARALLEL_PAGES * 120_000, maxMs: options.maxMs ?? 240_000,
      perSecond: options.perSecond ?? 6_000, maxInFlight: options.maxInFlight ?? 24,
      beforeRequest: assertLock, sharedBudget: options.sharedBudget,
    });
    const previous = saved?.version === CACHE_VERSION ? saved : null;
    const savedDraft = current.draft?.version === CACHE_VERSION ? current.draft : null;
    const draft = savedDraft || await begin(reader, previous);
    if (!draft) {
      const updated = await fillRaffleTotals(saved, wallet, reader);
      if (updated !== saved) {
        assertLock();
        await save(sql, wallet, current, updated, null);
      }
      return { ...fromCache(updated, wallet, reader.stats), cached: updated === saved };
    }
    const covered = await fillRaffleTotals(draft, wallet, reader);
    const end = options.blockWindow ? Math.min(covered.target, covered.through + options.blockWindow) : covered.target;
    const page = await directWalletReportBatch(wallet, covered.through + 1, end, reader);
    const { snapshot: next, campaignPayouts } = reconcileCampaign({
      ...covered, through: page.to,
      totals: addWalletTotals(covered.totals, summarizeWalletEvents(page.events)),
    }, wallet);
    const ready = page.to === covered.target;
    assertLock();
    await save(sql, wallet, current, ready ? next : current.snapshot, ready ? null : next);
    return {
      ready, cached: false, snapshot: ready ? { ...next, campaignPayouts } : null,
      progress: { from: WALLET_HISTORY_START, through: next.through, target: next.target, asOf: next.asOf, resumed: Boolean(savedDraft) },
      page, usage: reader.stats,
    };
  });
  return result ?? {
    ready: false, waiting: true, usage: { units: 0 },
    progress: first?.draft ? { from: WALLET_HISTORY_START, through: first.draft.through, target: first.draft.target, asOf: first.draft.asOf } : null,
  };
}
