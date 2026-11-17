import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const directory = new URL('../assets/tenor-cat-wait/', import.meta.url);
const entries = JSON.parse(await readFile(new URL('manifest.json', directory), 'utf8'));
if (!Array.isArray(entries) || entries.length < 20) throw Error('等待動畫清單不足 20 項');
const names = new Set();
for (const entry of entries) {
  if (!/^[a-z0-9-]+\.gif$/.test(entry.file) || names.has(entry.file) ||
      entry.license !== '未確認' || !entry.source?.startsWith('https://tenor.com/')) {
    throw Error('等待動畫名稱重複或授權資料不完整');
  }
  names.add(entry.file);
  const bytes = await readFile(new URL(entry.file, directory));
  if (!['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString()) ||
      bytes.length !== entry.bytes || createHash('sha256').update(bytes).digest('hex') !== entry.sha256) {
    throw Error(`等待動畫檔案損壞或與清單不符：${entry.file}`);
  }
}
console.log(`已驗證 ${entries.length} 個等待動畫及來源資料（授權未確認）`);
