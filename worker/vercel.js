import worker, { holdings, valid } from './index.js';
import { indexProgress, indexSummary, walletReport } from './history/report.js';
import { database } from './history/store.js';
import { refreshHistory } from './history/refresh.js';

const json = (body, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/') return worker.fetch(request);
    if (!['/api/init', '/api/scan', '/api/holdings', '/api/refresh'].includes(url.pathname)) return json({ error: 'Not found' }, 404);
    if (!process.env.DATABASE_URL?.trim()) return json({ error: 'Neon 歷史索引尚未接上' }, 503);
    try {
      const sql = database();
      if (url.pathname === '/api/init' && request.method === 'GET') {
        const index = await indexSummary(sql);
        if (!index) return json({ initializing: true, progress: await indexProgress(sql) }, 202);
        return json({ head: index.block, start: index.start, contracts: index.contracts, collections: index.collections,
          collectionsError: null, rpc: 'Neon / Alchemy Base Mainnet', chainId: 8453, asOf: index.as_of, indexed: true, refreshOnRequest: true });
      }
      if (url.pathname === '/api/refresh' && request.method === 'POST') {
        if (!process.env.ALCHEMY_API_KEY?.trim()) return json({ error: 'Alchemy Base RPC 尚未設定' }, 503);
        const body = await request.json().catch(() => null);
        if (!body || typeof body !== 'object' || Array.isArray(body) || (body.through !== undefined && (!Number.isSafeInteger(body.through) || body.through < 1))) {
          return json({ error: '增量查詢參數無效' }, 400);
        }
        const result = await refreshHistory(sql, body.through);
        if (!result) return json({ error: 'Neon 歷史索引正在回補' }, 503);
        return json(result, result.ready ? 200 : 202);
      }
      if (url.pathname === '/api/scan' && request.method === 'GET') {
        const wallet = (url.searchParams.get('wallet') || '').toLowerCase();
        const refund = url.searchParams.get('refund') || '';
        const from = Number(url.searchParams.get('from')), to = Number(url.searchParams.get('to'));
        if (!valid(wallet) || !Number.isSafeInteger(from) || !Number.isSafeInteger(to) || to < from) {
          return json({ error: '錢包地址或區塊範圍無效' }, 400);
        }
        if (refund) return json({ error: '歷史索引僅涵蓋平台已識別的發款；請清除自訂退款地址' }, 422);
        const report = await walletReport(sql, wallet, from, to);
        if (!report) return json({ error: '區塊範圍超出已發佈的索引' }, 409);
        if (report.to < to && url.searchParams.get('paged') !== '1') {
          return json({ error: '報表版本已更新，請重新整理頁面再查詢' }, 409);
        }
        return json(report);
      }
      if (url.pathname === '/api/holdings' && request.method === 'POST') {
        if (!process.env.ALCHEMY_API_KEY?.trim()) return json({ error: 'Alchemy Base RPC 尚未設定' }, 503);
        const body = await request.json().catch(() => null);
        if (!body || !valid(body.wallet) || !Number.isSafeInteger(body.block) || !Array.isArray(body.assets) || body.assets.length > 40
          || body.assets.some(asset => !asset || !valid(asset.collection) || typeof asset.tokenId !== 'string' || !/^\d{1,78}$/.test(asset.tokenId))) {
          return json({ error: '持倉查詢參數無效' }, 400);
        }
        const index = await indexSummary(sql);
        if (!index || body.block < index.start || body.block > index.block) {
          return json({ error: '持倉區塊超出已發佈的索引' }, 409);
        }
        return json({ assets: await holdings(body.wallet.toLowerCase(), body.assets, body.block) });
      }
      return json({ error: 'Method not allowed' }, 405);
    } catch (error) {
      if (error.code === '42P01') return json({ error: 'Neon 歷史索引尚未初始化' }, 503);
      console.error('Wallet report request failed', error.code || error.name);
      return json({ error: '歷史資料暫時無法讀取' }, 502);
    }
  },
};
