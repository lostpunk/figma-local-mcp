import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function readInstallationToken(root) {
  let data;
  try { data = JSON.parse(await readFile(join(root, 'generated/pairing-key.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  if (!/^[a-f0-9]{64}$/.test(data.token ?? '')) throw new Error('Invalid local installation key. Run setup again after removing generated/pairing-key.json.');
  return data.token;
}
