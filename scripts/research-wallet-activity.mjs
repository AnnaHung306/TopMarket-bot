import { parseArgs } from 'node:util';
import { loadEnvFile } from 'node:process';
import { createReader } from '../wallet-v2/reader.mjs';
import { researchActivity } from '../wallet-v2/research.mjs';
const { values } = parseArgs({ options: { contract: { type: 'string' }, 'official-url': { type: 'string' },
  output: { type: 'string' }, 'rpc-url': { type: 'string' } } });
try {
  try { loadEnvFile(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!values.contract || !values['official-url'] || !values.output) throw Error('Required: --contract 0x… --official-url https://… --output work/wallet-v2/research/activity');
  const candidate = await researchActivity({ reader: createReader({ rpcUrl: values['rpc-url'] }), contract: values.contract,
    officialUrl: values['official-url'], outputDirectory: values.output });
  console.log(JSON.stringify({ status: candidate.status, contract: candidate.contract, implementation: candidate.implementation,
    sourceFiles: candidate.sourceFiles.length, contractName: candidate.contractName, output: values.output }));
} catch (error) { console.error(String(error.message).replace(/https?:\/\/\S+/gi, '[source-url]')); process.exitCode = 1; }
