import { displayWalletTotals } from './worker/report/accounting.js';

export const money = value => {
  const negative = value < 0n;
  const n = negative ? -value : value;
  return `${negative ? '-' : ''}${(n / 1000000n).toLocaleString('en-US')}.${(n % 1000000n).toString().padStart(6, '0').replace(/0+$/, '').padEnd(2, '0')}`;
};

export function reportData(snapshot) {
  const t = displayWalletTotals(snapshot.totals, []);
  const rows = [
    ['抽卡花費（已核實）', t.pack], ['市場買卡（事件金額）', t.marketPurchases],
    ['銷售實收', t.sales], ['回購實收', t.buybackReceived], ['質押及留卡結算實收', t.stakingInflow],
    ['抽卡退款', t.refund], ['活動入帳', t.compensation + t.campaignPrizes + t.campaignOther],
    ...(t.raffleKnown ? [['奪寶參與（扣除退款）', t.raffleParticipation - t.raffleRefund], ['奪寶收入', t.raffleIncome]] : []),
  ];
  const pending = t.pendingPacks + t.pendingBuybacks + t.pendingStakingInflow + t.pendingRefunds;
  return { totals: t, rows, pending };
}

export function formatReport(wallet, snapshot, note = '') {
  const { totals: t, rows, pending } = reportData(snapshot);
  return `**Top.Market 錢包收支摘要**\n\`${wallet}\`\n` +
    rows.map(([label, amount]) => `${label}：${money(amount)} USDC`).join('\n') +
    `\n已識別淨收支：${money(t.net)} USDC` +
    `\n區塊：${snapshot.start}–${snapshot.through}\n資料時間：${snapshot.asOf}` +
    `${t.raffleCards ? `\n奪寶獎品：${t.raffleCards} 張卡` : ''}` +
    `${pending ? `\n⚠️ ${pending} 筆事件待核對，未計入已核實金額。` : ''}` +
    `${!t.raffleKnown || snapshot.rebuildRequired ? '\n⚠️ 舊版摘要，部分分類待更新。' : ''}` +
    `\n僅統計可識別的鏈上活動；不含持倉估值。${note ? `\n${note}` : ''}`;
}

export async function getReport(wallet, readPage, onProgress, now = () => Date.now()) {
  const deadline = now() + 12 * 60_000;
  let snapshot = null, afterBlock;
  let refresh = false;
  while (now() < deadline) {
    const result = await readPage(wallet, afterBlock);
    if (result.ready) {
      snapshot = result.snapshot;
      if (refresh) return { snapshot, note: '' };
      if (!result.cached) return { snapshot, note: '' };
      await onProgress('已讀取儲存的摘要，正在核對最新區塊…');
      afterBlock = snapshot.through;
      refresh = true;
      continue;
    }
    const p = result.progress;
    await onProgress(p ? `正在核對區塊 ${p.through} / ${p.target}，請稍候…` : '另一個查詢正在處理這個錢包，請稍候…');
    if (result.waiting) await new Promise(resolve => setTimeout(resolve, 3000));
  }
  if (snapshot) return { snapshot, note: '⚠️ 更新未完成，顯示先前已存摘要；請稍後再查詢。' };
  throw new Error('查詢時間較長，進度已保存。請稍後再次使用指令繼續。');
}
