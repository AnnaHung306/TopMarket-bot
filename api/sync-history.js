import { alchemy } from '../worker/history/chain.js';
import { database, publishedHead } from '../worker/history/store.js';
import { synchronize } from '../worker/history/sync.js';

export default {
  async fetch(request) {
    if (request.method !== 'GET') return new Response(null, { status: 405 });
    const secret = process.env.CRON_SECRET;
    if (!secret || request.headers.get('authorization') !== 'Bearer ' + secret) {
      return new Response(null, { status: 401 });
    }
    try {
      const sql = database();
      if (!await publishedHead(sql)) return Response.json({ error: 'Initial history backfill is required' }, { status: 503 });
      const reader = alchemy({ maxUnits: 1_250_000, maxMs: 245_000 });
      const stats = await synchronize(sql, { reader, maxMs: 220_000, range: 5_000 });
      return Response.json(stats);
    } catch (error) {
      console.error('Incremental history sync failed', error.code || error.status || error.name);
      return Response.json({ error: 'History sync incomplete. Completed chunks can resume.' }, { status: 503 });
    }
  },
};
