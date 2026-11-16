import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { fileURLToPath } from 'node:url';
import { money, reportData } from './discord-report.mjs';

if (!GlobalFonts.registerFromPath(fileURLToPath(new URL('./assets/NotoSansTC.ttf', import.meta.url)), 'Report Sans')) {
  throw Error('Report font failed to load');
}

export function renderPoster(wallet, snapshot, note = '') {
  const { totals, rows, pending } = reportData(snapshot);
  const canvas = createCanvas(1200, 1510), ctx = canvas.getContext('2d');
  const gradient = ctx.createLinearGradient(0, 0, 1200, 1510);
  gradient.addColorStop(0, '#152b35'); gradient.addColorStop(.47, '#090f16'); gradient.addColorStop(1, '#130f20');
  ctx.fillStyle = gradient; ctx.fillRect(0, 0, 1200, 1510);
  const glow = ctx.createRadialGradient(1040, 120, 0, 1040, 120, 800);
  glow.addColorStop(0, 'rgba(0,211,231,.28)'); glow.addColorStop(1, 'rgba(0,211,231,0)');
  ctx.fillStyle = glow; ctx.fillRect(0, 0, 1200, 1510);
  ctx.fillStyle = 'rgba(8,14,20,.84)'; ctx.strokeStyle = 'rgba(196,244,255,.36)'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.roundRect(52, 48, 1096, 1412, 36); ctx.fill(); ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,.08)'; ctx.beginPath(); ctx.roundRect(62, 58, 1076, 1392, 29); ctx.stroke();
  const text = (s, x, y, size, color = '#f0f7fa', align = 'left', maxWidth) => {
    ctx.font = `${size}px "Report Sans"`; ctx.fillStyle = color; ctx.textAlign = align;
    if (maxWidth) ctx.fillText(s, x, y, maxWidth); else ctx.fillText(s, x, y);
  };
  text('TOP.MARKET', 100, 127, 32, '#e8faff');
  text('BASE  /  WALLET REPORT', 1100, 127, 21, '#7edfea', 'right');
  ctx.fillStyle = '#5ce4ee'; ctx.fillRect(100, 159, 58, 4);
  text('錢包收支報表', 100, 230, 49);
  text(wallet, 100, 280, 23, '#99b4bf', 'left', 1000);
  text('已識別淨收支', 100, 371, 26, '#9bb4be');
  const net = (totals.net > 0n ? '+' : '') + money(totals.net);
  text(net, 100, 462, 76, totals.net >= 0n ? '#71f3d4' : '#ffac9c', 'left', 790);
  text('USDC', 1090, 459, 28, '#a6c0c7', 'right');
  ctx.strokeStyle = 'rgba(177,223,232,.20)'; ctx.beginPath(); ctx.moveTo(100, 504); ctx.lineTo(1100, 504); ctx.stroke();
  text('收支明細', 100, 566, 26, '#d6f4f5');
  text('AMOUNT / USDC', 1100, 566, 19, '#7d9ba5', 'right');
  const start = 620, step = 58;
  rows.forEach(([label, amount], i) => {
    const y = start + i * step;
    text(label, 100, y, 25, '#c0d1d6');
    text(money(amount), 1100, y, 27, '#f1fafb', 'right', 450);
    ctx.strokeStyle = 'rgba(177,223,232,.10)'; ctx.beginPath(); ctx.moveTo(100, y + 21); ctx.lineTo(1100, y + 21); ctx.stroke();
  });
  let y = 1220;
  text(`區塊 ${snapshot.start.toLocaleString('en-US')} – ${snapshot.through.toLocaleString('en-US')}`, 100, y, 21, '#a1bbc3');
  text(`資料時間 ${snapshot.asOf}`, 100, y + 38, 20, '#a1bbc3');
  if (totals.raffleCards > 0n) text(`奪寶獎品 ${totals.raffleCards} 張卡`, 100, y + 76, 20, '#a1bbc3');
  const notices = [];
  if (pending) notices.push(`${pending} 筆事件待核對，未計入已核實金額`);
  if (!totals.raffleKnown || snapshot.rebuildRequired) notices.push('舊版摘要，部分分類待更新');
  if (note) notices.push(note.includes('未自動') ? '已存摘要，未自動更新' : '更新未完成，顯示先前已存摘要');
  text(notices.join('　·　') || '僅統計可識別鏈上活動，不含持倉估值', 100, 1392, 18, '#a8bdc3', 'left', 1000);
  return canvas.toBuffer('image/png');
}
