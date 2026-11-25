export const CHAIN_ID = 8453;
export const SCHEMA_VERSION = 1;
export const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
export const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
export const SCOPES = Object.freeze({
  all: '全部', packs: '抽卡', upgrade: '卡牌升級', raffle: '奪寶', market: '市場交易',
  buyback: '回購', staking: '質押與留卡結算', campaign: '活動入帳',
});
export const OUTCOME_LABELS = Object.freeze({ won: '成功', lost: '失敗', pending: '待結算', rescued: '已救援退卡' });
export const DELIVERY_LABELS = Object.freeze({ delivered: '已收到', claimable: '待領取', unverified: '交付待核對', none: '無獎品',
  'choice-pending': '待選擇留卡或回購', recycled: '已回購入帳', 'payout-unverified': '回購入帳待核對' });
export const CATEGORY_LABELS = Object.freeze({ pack: '抽卡支出', purchaseGross: '市場買卡', sales: '市場賣卡',
  'buyback-claim-confirmed': '回購實收', 'refund-confirmed': '抽卡退款', 'staking-confirmed': '質押收益',
  'staking-treasury': '質押收益', 'kept-disposal-confirmed': '留卡結算實收', 'campaign-payout': '活動入帳',
  'raffle-participation': '奪寶參與', 'raffle-income': '奪寶收入', 'raffle-refund': '奪寶退款', WinRecycled: '升級卡回購實收' });
export function address(value) {
  if (typeof value !== 'string' || !/^0x[\da-f]{40}$/i.test(value)) throw Error('無效的錢包或合約地址');
  return value.toLowerCase();
}
export const hex = value => '0x' + BigInt(value).toString(16);
export const word = value => '0x' + value.slice(2).padStart(64, '0');
export const asAddress = value => address('0x' + value.slice(-40));
export function words(data) {
  if (!/^0x(?:[\da-f]{64})*$/i.test(data)) throw Error('Invalid ABI event data');
  return data.slice(2).match(/.{64}/g) || [];
}
export const integer = value => BigInt(value).toString();
export function eventId(tx, index) { return `${CHAIN_ID}:${tx.toLowerCase()}:${Number(index)}`; }
export const assetKey = (collection, tokenId) => `${address(collection)}:${BigInt(tokenId)}`;
export function displayPoolName(pool) {
  const name = String(pool.name || '').replace(/0x[\da-f]{8,}(?:…)?/gi, '').replace(/鏈上卡池\s*/g, '').trim();
  return name || (pool.kind === 'upgrade' ? '卡牌升級' : '未命名卡包');
}
export function money(raw, decimals = 6) {
  if (raw === null || raw === undefined) return '未知';
  const value = BigInt(raw), abs = value < 0n ? -value : value, unit = 10n ** BigInt(decimals);
  const whole = (abs / unit).toLocaleString('en-US');
  const fraction = (abs % unit).toString().padStart(decimals, '0').replace(/0+$/, '').padEnd(2, '0');
  return `${value < 0n ? '-' : ''}${whole}.${fraction}`;
}
export function ordered(a, b) { return a.block - b.block || a.logIndex - b.logIndex || a.id.localeCompare(b.id); }
export function taipeiDay(value, end = false) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) throw Error('日期格式應為 YYYY-MM-DD');
  const ms = Date.parse(`${value}T00:00:00+08:00`);
  if (!Number.isFinite(ms) || new Date(ms + 8 * 3600_000).toISOString().slice(0, 10) !== value) throw Error('無效日期');
  return ms / 1000 + (end ? 86400 : 0);
}
export function dateRange({ period = 'all', from, to } = {}, now = Date.now()) {
  const today = new Date(now + 8 * 3600_000).toISOString().slice(0, 10);
  if (period === 'custom') {
    const start = taipeiDay(from), end = taipeiDay(to, true);
    if (start >= end) throw Error('起始日期不得晚於結束日期');
    return { start, end, label: `${from} ～ ${to}（台灣時間）` };
  }
  if (period === 'all') return { start: -Infinity, end: Infinity, label: '全期間' };
  if (period === 'month') return { start: taipeiDay(today.slice(0, 7) + '-01'), end: Infinity, label: '本月（台灣時間）' };
  if (!['7d', '30d'].includes(period)) throw Error('無效期間');
  const days = Number(period.slice(0, -1));
  return { start: taipeiDay(today) - (days - 1) * 86400, end: Infinity, label: `近 ${days} 天（台灣時間）` };
}
export function cleanJson(value) { return JSON.parse(JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v)); }
export function displayTime(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return '尚未取得';
  return new Date(value).toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' }) + '（台灣時間）';
}
