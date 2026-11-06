import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import worker from '../worker/index.js';

const sourceFile = new URL('../worker/index.js', import.meta.url);
const outputFile = new URL('../dist/server/index.js', import.meta.url);
const [source, license, response] = await Promise.all([
  readFile(sourceFile, 'utf8'),
  readFile(new URL('../worker/report/glass-refraction.LICENSE', import.meta.url), 'utf8'),
  worker.fetch(new Request('http://localhost/')),
]);
assert.equal(response.status, 200);

// Inline the rendered page so the distributed Worker stays a single ESM file.
const pageImport = "import { renderWalletReport } from './report/page.js';\n\n";
const pageDeclaration = 'const HTML=renderWalletReport(linkAcquisitionCosts);';
assert(source.startsWith(pageImport) && source.includes(pageDeclaration), 'Worker page link changed');
const html = await response.text();
const standalone = source.slice(pageImport.length)
  .replace(pageDeclaration, () => 'const HTML=' + JSON.stringify(html) + ';');
await mkdir(new URL('.', outputFile), { recursive: true });
await writeFile(outputFile, '/* Liquid Glass refraction license:\n' + license + '*/\n' + standalone);
console.log('Built ' + outputFile.pathname);
