import { scanStatusMarkup } from './scan-status.js';
import { reportBackgroundScript } from './background.js';
import { reportEntryMotionStyles } from './entry-motion.js';
import { topMarketLogo } from './brand.js';
import { reportClientScript } from './client.js';
import { installGlassRefraction } from './glass-refraction.js';
import { disclosure } from './methodology.js';
import { reportStyles } from './styles.js';

export function renderWalletReport(linkAcquisitionCosts) {
  return String.raw`<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#050506">
  <title>Top.Market · Wallet Report</title>
  <style>${reportStyles}${reportEntryMotionStyles}</style>
</head>
<body>
  <header class="site-header">
    <div class="header-inner">
      <div class="header-brand">
        <img src="${topMarketLogo}" alt="Top Market" width="62" height="34">
        <span>Wallet Report</span>
      </div>
      <div class="network"><span aria-hidden="true"></span> Base 主網 <i aria-hidden="true">·</i> 唯讀</div>
    </div>
  </header>
  <canvas class="ambient" id="report-background" aria-hidden="true"></canvas>
  <main>
    <section class="intro" aria-labelledby="title">
      <div class="eyebrow"><span></span> BASE / ON-CHAIN ANALYTICS</div>
      <h1 id="title">Wallet report<span>.</span></h1>
      <p>用 Base 鏈上紀錄查核錢包收入、持倉與逐筆交易證據。</p>
      <p class="gpu-status" id="gpu-status" role="status" hidden></p>
    </section>

    <section class="glass query" data-lens="query" aria-labelledby="query-title">
      <div class="section-heading">
        <h2 id="query-title">錢包查詢</h2>
      </div>
      <form class="form" id="form">
        <label for="wallet">Base 錢包地址</label>
        <div class="form-controls">
          <input id="wallet" placeholder="0x…" autocomplete="off" spellcheck="false" required pattern="0x[a-fA-F0-9]{40}">
          <button id="analyze">分析錢包 <span aria-hidden="true">→</span></button>
          <button class="quiet" type="button" id="cancel" hidden>停止掃描</button>
          <button class="quiet" type="button" id="update" hidden>更新到最新區塊</button>
        </div>
      </form>
      ${scanStatusMarkup}
    </section>

    <section class="glass overview" data-lens="overview" aria-labelledby="overview-title">
      <div class="section-heading"><h2 id="overview-title">報表總覽</h2><span class="section-index">01 / SUMMARY</span></div>
      <h3>已識別淨收支</h3>
      <div class="total"><div class="big" id="cash">—</div><span>USDC</span></div>
      <div class="caption" id="coverage">輸入錢包以讀取 Base 鏈上紀錄</div>
      <div class="metrics" id="metrics"></div>
      <div class="split">
        <div><span>已實現損益</span><b>未計算</b></div>
        <div><span>未實現損益</span><b>未計算</b></div>
        <div><span>已核實持倉</span><b id="holdingCount">—</b></div>
      </div>
    </section>

    <section class="glass evidence" data-lens="evidence" aria-labelledby="evidence-title">
      <div class="section-heading"><h2 id="evidence-title">交易證據</h2><span class="section-index">02 / TRANSACTIONS</span></div>
      <div class="table-wrap" role="region" aria-label="交易證據表格" tabindex="0">
        <table><thead><tr><th scope="col">類型</th><th scope="col">USDC</th><th scope="col">區塊</th><th scope="col">交易證據</th></tr></thead><tbody id="rows"><tr><td colspan="4" class="empty">鏈上證據將顯示於此</td></tr></tbody></table>
      </div>
      <div class="actions"><button class="quiet" id="csv" disabled>匯出 CSV</button><button class="quiet" id="json" disabled>匯出完整 JSON</button><button class="quiet" id="fullEvidence" type="button" hidden>重新核對完整逐筆（會查鏈）</button></div>
    </section>

    <section class="glass holdings" data-lens="holdings" aria-labelledby="holdings-title">
      <div class="section-heading"><h2 id="holdings-title">持倉與質押</h2><span class="section-index">03 / HOLDINGS</span></div>
      <p class="caption">由選定期間的抽卡、購買與質押事件發現候選卡片，再以 ownerOf / stakerOf 在固定快照區塊核實。外部轉入與更早部位可能缺漏。</p>
      <div id="assets"><p class="caption">尚未查核持倉</p></div>
    </section>

    <aside class="glass poster" data-lens="poster" id="poster" aria-labelledby="poster-title">
      <div class="poster-top"><img class="poster-brand" id="posterBrand" src="${topMarketLogo}" alt="Top Market" width="52" height="28"><span class="section-index">BASE / REPORT</span></div>
      <h2 id="poster-title">報告海報</h2>
      <p class="wallet" id="posterWallet">YOUR BASE WALLET</p>
      <div class="poster-total">
        <div class="caption">已識別淨收支</div>
        <div class="total"><div class="big" id="posterCash">—</div><span>USDC</span></div>
      </div>
      <div id="posterMetrics"></div>
      <p class="caption poster-date" id="posterDate">BASE / EVIDENCE FIRST</p>
      <div class="poster-actions">
        <button id="download" disabled>下載海報 PNG <span aria-hidden="true">↓</span></button>
        <button class="quiet" id="print" disabled>列印 / 儲存 PDF</button>
      </div>
      <p class="caption" id="posterStatus" role="status"></p>
    </aside>

    <footer>${disclosure}</footer>
  </main>
  <script>${reportClientScript(linkAcquisitionCosts)}</script>
  <script type="module">${reportBackgroundScript()}</script>
  <script type="module">(${installGlassRefraction.toString()})(glassRefractionTools);</script>
</body>
</html>`;
}
