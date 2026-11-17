import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium as playwright } from 'playwright-core';
import { renderWalletReport } from './worker/report/page.js';
import { linkAcquisitionCosts } from './worker/index.js';

// The Discord image is rendered by Gavin's own page and PNG export function.
// Rendering is offline: it reads only the snapshot already obtained by the bot.
const reportHtml = renderWalletReport(linkAcquisitionCosts);
let browserPromise;
let fontPromise;

async function posterBrowser() {
  if (browserPromise && !(await browserPromise).isConnected()) browserPromise = undefined;
  if (!browserPromise) browserPromise = (async () => {
    if (process.platform === 'win32' || process.platform === 'darwin') {
      return playwright.launch({ channel: 'chrome', headless: true });
    }
    const { default: chromium } = await import('@sparticuz/chromium');
    return playwright.launch({ args: chromium.args, executablePath: await chromium.executablePath(), headless: true });
  })().catch(error => { browserPromise = undefined; throw error; });
  return browserPromise;
}

export async function closePosterBrowser() {
  if (!browserPromise) return;
  const browser = await browserPromise;
  browserPromise = undefined;
  await browser.close();
}

export async function renderGavinPoster(wallet, snapshot) {
  if (!fontPromise) fontPromise = readFile(fileURLToPath(new URL('./assets/NotoSansTC.ttf', import.meta.url)))
    .then(bytes => bytes.toString('base64'));
  const [browser, font] = await Promise.all([posterBrowser(), fontPromise]);
  const context = await browser.newContext({
    viewport: { width: 1200, height: 1000 }, deviceScaleFactor: 1, offline: true, reducedMotion: 'reduce',
  });
  try {
    const page = await context.newPage();
    await page.setContent(reportHtml, { waitUntil: 'load' });
    const encoded = await page.evaluate(async ({ wallet, snapshot, font }) => {
      const style = document.querySelector('head style');
      style.textContent = `@font-face { font-family: "Report Sans"; src: url(data:font/ttf;base64,${font}); }
        :root { --sans: "Report Sans", sans-serif; }
        ${style.textContent}`;
      state = {
        events: [], wallet, summary: snapshot, from: snapshot.start, through: snapshot.through,
        head: snapshot.through, asOf: snapshot.asOf, started: true, complete: true,
        cacheHit: true, fullEvidence: false, holdingsChecked: false,
      };
      render();
      await document.fonts.ready;
      const canvas = await renderWalletPoster(
        document.getElementById('poster'), document.getElementById('report-background'),
        state.complete && !totals().pendingPacks, glassRefractionTools,
      );
      return canvas.toDataURL('image/png').split(',')[1];
    }, { wallet, snapshot, font });
    return Buffer.from(encoded, 'base64');
  } finally {
    await context.close();
  }
}
