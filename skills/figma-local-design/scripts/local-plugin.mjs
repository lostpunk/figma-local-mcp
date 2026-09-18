import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, readFile, chmod, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { readInstallationToken } from '../src/pairing.mjs';

export async function prepareLocalPlugin(root) {
  const generated = join(root, 'generated');
  await mkdir(generated, { recursive: true, mode: 0o700 });
  let token = await readInstallationToken(root);
  const keyPath = join(generated, 'pairing-key.json');
  if (!token) {
    try {
      await writeFile(keyPath, JSON.stringify({ token: randomBytes(32).toString('hex') }) + '\n', { flag: 'wx', mode: 0o600 });
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
    token = await readInstallationToken(root);
  }
  if (!token) throw new Error('Existing installation key is invalid; it was preserved for recovery');
  await chmod(keyPath, 0o600);
  const target = join(generated, 'figma-plugin');
  await mkdir(target, { recursive: true, mode: 0o700 });
  await chmod(target, 0o700);
  let existingId;
  try { existingId = JSON.parse(await readFile(join(target, 'manifest.json'), 'utf8')).id; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const html = await readFile(join(root, 'plugin/ui.html'), 'utf8');
  const marker = "const installationToken = '';";
  if (!html.includes(marker)) throw new Error('Missing local pairing UI marker');
  for (const name of ['manifest.json', 'code.js', 'ui.html']) {
    let contents = name === 'ui.html' ? html.replace(marker, `const installationToken = '${token}';`)
      : await readFile(join(root, 'plugin', name));
    if (name === 'manifest.json') {
      const manifest = JSON.parse(contents.toString());
      manifest.id = typeof existingId === 'string' && existingId ? existingId : manifest.id + '-auto';
      manifest.name += ' Auto';
      contents = JSON.stringify(manifest, null, 2) + '\n';
    }
    const temporary = join(target, `.${name}-${randomBytes(8).toString('hex')}.tmp`);
    try {
      await writeFile(temporary, contents, { mode: 0o600, flag: 'wx' });
      await rename(temporary, join(target, name));
    } finally { await rm(temporary, { force: true }); }
  }
  return join(target, 'manifest.json');
}
