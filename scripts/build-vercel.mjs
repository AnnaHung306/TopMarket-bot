import { mkdir, writeFile } from 'node:fs/promises';
import worker from '../worker/index.js';

const output = new URL('../dist/vercel-static/', import.meta.url);
const homepage = await worker.fetch(new Request('http://localhost/'));
if (!homepage.ok || !homepage.headers.get('content-type')?.startsWith('text/html')) {
  throw new Error('The wallet report did not render an HTML homepage');
}

await mkdir(output, { recursive: true });
await writeFile(new URL('index.html', output), await homepage.text());
