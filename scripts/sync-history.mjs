import { database } from '../worker/history/store.js';
import { synchronize } from '../worker/history/sync.js';

try {
  const progress = process.argv.includes('--progress');
  const report = await synchronize(database(), { onProgress: data => {
    if (progress) console.error(JSON.stringify(data));
  } });
  console.log(JSON.stringify(report));
  if (report.through < report.target) process.exitCode = 1;
} catch (error) {
  const safe = /^((?:Finalized|Invalid|Cannot|Published|Alchemy sync budget|Neon DATABASE_URL|Alchemy Base RPC) )/.test(error.message);
  console.error(safe ? error.message : 'History sync failed. Completed Neon chunks were retained.', error.code || error.status || '');
  process.exitCode = 1;
}
