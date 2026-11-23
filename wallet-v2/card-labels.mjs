import { officialJson } from './registry.mjs';
import { address, assetKey } from './model.mjs';
import { forEachBatch } from './batch.mjs';

// Public metadata supplies names only; historical prices and accounting never use these API values.
export async function updateCardLabels(ledger, { fetchRecord = officialJson } = {}) {
  ledger.cardLabelsChecked ||= {};
  ledger.cards ||= {};
  const warning = '部分卡名資料暫時不可用；以合約與 token ID 顯示，鏈上金額不受影響';
  ledger.warnings = ledger.warnings.filter(item => item !== warning);
  let unavailable = false;
  const missing = ledger.events.filter(event => event.category === 'UpgradeRequested' && !ledger.cardLabelsChecked[event.id]);
  await forEachBatch(missing, 6, async event => {
    if (unavailable) return;
    let data;
    try { data = await fetchRecord(`card-upgrades/records?tx_hash=${encodeURIComponent(event.tx)}&page=1&page_size=20`, { signal: AbortSignal.timeout(5000) }); }
    catch {
      unavailable = true;
      ledger.warnings = [...new Set([...ledger.warnings, warning])];
      return;
    }
    const records = (Array.isArray(data.list) ? data.list : []).filter(record => record.tx_hash?.toLowerCase() === event.tx && String(record.spin_id) === event.spinId);
    if (records.length !== 1) return;
    const record = records[0];
    for (const [card, collection, tokenId] of [[record.stake_card, event.stakeCollection, event.stakeTokenId],
      [record.target_card, event.targetCollection, event.targetTokenId]]) {
      if (!card?.card_name || !/^0x[\da-f]{40}$/i.test(card.collection || '') || address(card.collection) !== collection || String(card.token_id) !== tokenId) continue;
      ledger.cards[assetKey(collection, tokenId)] = { name: card.card_name, source: 'official-upgrade-record', transaction: event.tx };
    }
    ledger.cardLabelsChecked[event.id] = true;
  });
}
