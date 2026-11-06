import worker, { holdings, valid } from './index.js';
import { alchemy } from './history/chain.js';
import { directWalletHead, directWalletReport, finalizedWalletBlock, WALLET_HISTORY_START } from './wallet-direct.js';

const json = (body, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/') return worker.fetch(request);
    if (!['/api/init', '/api/scan', '/api/holdings'].includes(url.pathname)) return json({ error: 'Not found' }, 404);
    if (!process.env.ALCHEMY_API_KEY?.trim()) return json({ error: 'Alchemy Base RPC 尚未設定' }, 503);
    try {
      if (url.pathname === '/api/init' && request.method === 'GET') return json(await directWalletHead());
      if (url.pathname === '/api/scan' && request.method === 'GET') {
        if (url.searchParams.get('mode') !== 'wallet') return json({ error: '報表版本已更新，請重新整理頁面再查詢' }, 409);
        const wallet = (url.searchParams.get('wallet') || '').toLowerCase();
        const from = Number(url.searchParams.get('from')), to = Number(url.searchParams.get('to'));
        if (!valid(wallet) || !Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < WALLET_HISTORY_START || to < from) {
          return json({ error: '錢包地址或區塊範圍無效' }, 400);
        }
        const reader = alchemy({ maxUnits: 120_000, maxMs: 240_000 });
        const head = await finalizedWalletBlock(reader);
        if (to > Number(head.number)) return json({ error: '指定區塊尚未最終確認' }, 409);
        const report = await directWalletReport(wallet, from, to, reader);
        return json({ ...report, usage: reader.stats });
      }
      if (url.pathname === '/api/holdings' && request.method === 'POST') {
        const body = await request.json().catch(() => null);
        if (!body || !valid(body.wallet) || !Number.isSafeInteger(body.block) || !Array.isArray(body.assets) || body.assets.length > 40
          || body.assets.some(asset => !asset || !valid(asset.collection) || typeof asset.tokenId !== 'string' || !/^\d{1,78}$/.test(asset.tokenId))) {
          return json({ error: '持倉查詢參數無效' }, 400);
        }
        const head = await finalizedWalletBlock(alchemy({ maxUnits: 500 }));
        if (body.block < WALLET_HISTORY_START || body.block > Number(head.number)) return json({ error: '持倉區塊超出已最終確認的範圍' }, 409);
        return json({ assets: await holdings(body.wallet.toLowerCase(), body.assets, body.block) });
      }
      return json({ error: 'Method not allowed' }, 405);
    } catch (error) {
      console.error('Wallet report request failed', error.code || error.status || error.name);
      if (/Alchemy sync (?:budget|time limit)/.test(error.message)) {
        return json({ error: '本段錢包活動超過服務限制，報表尚未完成' }, 503);
      }
      return json({ error: '錢包鏈上資料暫時無法讀取' }, 502);
    }
  },
};
