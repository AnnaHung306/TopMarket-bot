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
    `\n資料時間：${snapshot.asOf}` +
    `${t.raffleCards ? `\n奪寶獎品：${t.raffleCards} 張卡` : ''}` +
    `${pending ? `\n⚠️ ${pending} 筆事件待核對，未計入已核實金額。` : ''}` +
    `${!t.raffleKnown || snapshot.rebuildRequired ? '\n⚠️ 舊版摘要，部分分類待更新。' : ''}` +
    `\n僅統計可識別的鏈上活動；不含持倉估值。${note ? `\n${note}` : ''}`;
}
