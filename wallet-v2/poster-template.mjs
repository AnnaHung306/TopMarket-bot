import { displayTime } from './model.mjs';
import { posterGlassCss } from './poster-glass.mjs';
import { headlineMetric, summaryValue, reportNumber, showHoldings, reportTitle } from './report-text.mjs';

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const rawAttribute = metric => `data-key="${metric.key}" data-raw="${metric.raw ?? 'unknown'}"`;

// Gavin's poster hierarchy: one glass card, one total, compact labelled rows.
export function posterHtml(report, { font, logo }) {
  const main = headlineMetric(report), u = report.upgrade, h = report.holdingsSummary;
  const rows = report.filter.scope === 'upgrade' ? '' : report.siteSummary.map(row =>
    `<div class="poster-row metric" ${rawAttribute(row)}><span>${escape(row.label)}</span><strong>${escape(summaryValue(row))}</strong></div>`).join('');
  const price = report.filter.scope === 'upgrade' ? null : report.metrics.find(row => row.key === 'upgradeValue');
  const pending = [[u.pending, '待結算'], [u.rescued, '已救援'], [u.claimable, '待領取'], [u.awaitingChoice, '待選擇留卡或回購'], [u.unverifiedDelivery, '交付待核對']]
    .filter(([count]) => count).map(([count, label]) => label + ' ' + count).join(' · ');
  const upgrade = ['all', 'upgrade'].includes(report.filter.scope) ? `<section class="upgrade"><h2>卡牌升級</h2>
    <div class="upgrade-stats">參與 <b>${u.requests}</b> 次 <span>成功 <b>${u.won}</b></span><span>失敗 <b>${u.lost}</b></span></div>
    ${price ? `<div class="poster-row metric" ${rawAttribute(price)}><span>${escape(price.label)}</span><strong>${escape(reportNumber(price.raw))}</strong></div>` : ''}
    ${pending ? `<p class="notice">${escape(pending)}</p>` : ''}</section>` : '';
  const color = main.raw == null ? '#d5e7f5' : BigInt(main.raw) < 0n ? '#ff8288' : '#66e5a3';
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Top.Market Wallet Report</title><style>
    @font-face{font-family:Report;src:url(data:font/ttf;base64,${font})}
    *{box-sizing:border-box}body{margin:0;background:#050506;color:#f5f7fa;font-family:Report,Arial,sans-serif}
    article{width:1120px;padding:28px;background:radial-gradient(ellipse at 100% 6%,#17336870,transparent 61%),radial-gradient(ellipse at 0 95%,#0d263d55,transparent 55%),#050506}
    .poster{border-radius:24px;padding:44px 48px}.poster-top{display:flex;justify-content:space-between;align-items:center;gap:24px}
    .brand{display:block;width:144px;height:auto}.section-index{font:650 18px/1.3 monospace;letter-spacing:2px;color:#b9c8d1}
    h1{font-size:48px;line-height:1.2;letter-spacing:-1px;margin:24px 0 14px}.wallet{font:23px/1.5 monospace;color:#a9b3be;overflow-wrap:anywhere}
    .period{font-size:26px;color:#a9b3be;margin-top:12px}.poster-total{margin:28px 0 24px}.poster-total>span{display:block;font-size:27px;color:#b9c8d1}
    .poster-total strong{display:block;font-size:104px;line-height:1.12;font-weight:760;letter-spacing:-3px;margin:12px 0 8px;overflow-wrap:anywhere;color:${color}}
    .poster-total small{font:700 26px/1.3 monospace;color:#71e8ff}
    .poster-row{display:flex;justify-content:space-between;align-items:baseline;gap:28px;border-top:1px solid #d2e5f124;padding:17px 0;font-size:28px}
    .poster-row>span{color:#b9c8d1;flex:1;min-width:0}.poster-row strong{font-size:34px;line-height:1.3;text-align:right;overflow-wrap:anywhere;font-variant-numeric:tabular-nums;max-width:62%}
    .poster-row[data-key=staking]>span,.poster-row[data-key=staking] strong{color:#72b7ff}
    .upgrade{margin-top:20px;border-top:1px solid #9eddf75c;padding-top:22px}h2{font-size:32px;margin:0 0 16px}
    .upgrade-stats{font-size:27px;color:#b9c8d1;display:flex;align-items:baseline;gap:14px;margin:10px 0 20px}.upgrade-stats span{margin-left:24px}.upgrade-stats b{color:#f5f7fa;font-size:34px}
    .poster-row[data-key=upgradeValue] strong{color:#b9c6ff}.holdings{border-top:1px solid #d2e5f124;margin-top:14px;padding-top:20px;font-size:27px;color:#b9c8d1;display:flex;justify-content:space-between;gap:24px}
    .notice{font-size:24px;color:#edd59d;margin:14px 0 0}.footer{font-size:22px;line-height:1.6;color:#a9b3be;margin-top:24px;overflow-wrap:anywhere}
    ${posterGlassCss}
    @media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
  </style></head><body><article id="wallet-v2-poster" data-scope="${report.filter.scope}"><section class="poster glass">
    <header class="poster-top"><img class="brand" src="data:image/svg+xml;base64,${logo}" alt="Top Market" width="144" height="77"><span class="section-index">BASE / REPORT</span></header>
    <h1>${escape(reportTitle(report))}</h1><div class="wallet">${escape(report.wallet)}</div><div class="period">${escape(report.range.label)}</div>
    <div class="poster-total metric" ${rawAttribute(main)}><span>${escape(main.label)}</span><strong>${escape(reportNumber(main.raw))}</strong><small>USDC</small></div>
    <div class="poster-rows">${rows}</div>${upgrade}
    ${showHoldings(report) ? `<div class="holdings metric" data-key="holdingsValue" data-raw="${h.valueRaw ?? 'unknown'}"><span>目前卡牌持倉（估值）</span><span>${escape(reportNumber(h.valueRaw))}${h.valueRaw == null ? '' : ' USDC'}</span></div>` : ''}
    ${!report.complete || report.pending.length ? '<p class="notice">部分資料待核對</p>' : ''}
    <footer class="footer">資料截至：${escape(displayTime(report.asOf))}</footer>
  </section></article></body></html>`;
}
