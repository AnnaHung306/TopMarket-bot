import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { address, asAddress, hex } from './model.mjs';
import { IMPLEMENTATION_SLOT } from './registry.mjs';

// Generates research evidence only. It never enables or registers a new adapter.
export async function researchActivity({ reader, contract, officialUrl, outputDirectory, fetchImpl = fetch }) {
  contract = address(contract);
  if (!officialUrl?.startsWith('https://')) throw Error('An official HTTPS activity source is required');
  if (Number(await reader.rpc('eth_chainId', [])) !== 8453) throw Error('Research RPC must be Base Mainnet');
  const head = await reader.rpc('eth_getBlockByNumber', ['finalized', false]);
  const slot = await reader.rpc('eth_getStorageAt', [contract, IMPLEMENTATION_SLOT, head.number]);
  let implementation = /^0x0+$/.test(slot) ? contract : asAddress(slot), beacon = null;
  if (implementation === contract) {
    const beaconSlot = await reader.rpc('eth_getStorageAt', [contract, '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50', head.number]);
    if (!/^0x0+$/.test(beaconSlot)) {
      beacon = asAddress(beaconSlot);
      implementation = asAddress(await reader.rpc('eth_call', [{ to: beacon, data: '0x5c60da1b' }, head.number]));
    }
  }
  const sourceUrl = `https://sourcify.dev/server/v2/contract/8453/${implementation}?fields=all`;
  const response = await fetchImpl(sourceUrl);
  if (!response.ok) throw Error('Verified contract source is unavailable; activity remains unsupported');
  const source = await response.json();
  if (!['match', 'exact_match'].includes(source.runtimeMatch)) throw Error('Contract runtime is not verified');
  const onchain = await reader.rpc('eth_getCode', [implementation, hex(Number(head.number))]);
  if (onchain.toLowerCase() !== source.runtimeBytecode.onchainBytecode.toLowerCase()) throw Error('Verified source is not the current implementation code');
  const sourceFiles = Object.entries(source.sources).map(([path, file]) => ({ path,
    sha256: createHash('sha256').update(file.content).digest('hex'), content: file.content }));
  const candidate = { status: 'research-only', chainId: 8453, contract, implementation, beacon, officialUrl,
    sourceUrl, block: Number(head.number), blockHash: head.hash, verifiedAt: source.verifiedAt,
    contractName: source.compilation.name, abi: source.abi, signatures: source.signatures,
    sourceFiles, requiredReview: ['official activity and start block mapping', 'proxy history and ABI epochs',
      'participant attribution including relayers', 'cash and NFT receipt matching', 'success/failure/rescue/delivery fixtures',
      'accounting and ownership continuity', 'shared report export consistency'] };
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(join(outputDirectory, 'research.json'), JSON.stringify(candidate, null, 2));
  return candidate;
}
