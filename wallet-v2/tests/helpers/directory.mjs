import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Keep rapid atomic-write checks outside OneDrive's synchronized checkout.
// Emit the exact owned directory so cleanup can be listed before deletion.
export function testDirectory(purpose) {
  const directory = mkdtempSync(join(tmpdir(), `topmarket-wallet-v2-${purpose}-`));
  console.log('wallet_v2_test_directory', JSON.stringify(directory));
  return directory;
}
