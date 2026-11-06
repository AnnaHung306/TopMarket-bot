import { alchemy } from '../worker/history/chain.js';
import { database } from '../worker/history/store.js';
import { synchronize } from '../worker/history/sync.js';

try {
  const progress = process.argv.includes('--progress');
  const maxUnits = Number(process.env.HISTORY_RPC_MAX_CU || 8_000_000);
  const perSecond = Number(process.env.HISTORY_RPC_CU_PER_SECOND || 6_000);
  if (!Number.isSafeInteger(maxUnits) || maxUnits < 1 || !Number.isSafeInteger(perSecond) || perSecond < 1) {
    throw Error('Invalid history RPC budget or throughput');
  }
  const report = await synchronize(database(), {
    reader: alchemy({ maxUnits, perSecond }), parallelChunks: 3,
    onProgress: data => { if (progress) console.error(JSON.stringify(data)); },
  });
  console.log(JSON.stringify(report));
  if (report.through < report.target) process.exitCode = 1;
} catch (error) {
  const safe = /^((?:Finalized|Invalid|Cannot|Published|Alchemy sync budget|Neon DATABASE_URL|Alchemy Base RPC) )/.test(error.message);
  console.error(safe ? error.message : 'History sync failed. Completed Neon chunks were retained.', error.code || error.status || '');
  process.exitCode = 1;
}
