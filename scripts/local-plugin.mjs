import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, readFile, chmod } from 'node:fs/promises';
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
  await chmod(keyPath, 0o600);
  const target = join(generated, 'figma-plugin');
  await mkdir(target, { recursive: true, mode: 0o700 });
  await chmod(target, 0o700);
  const html = await readFile(join(root, 'plugin/ui.html'), 'utf8');
  const marker = "const installationToken = '';";
  if (!html.includes(marker)) throw new Error('Missing local pairing UI marker');
  for (const name of ['manifest.json', 'code.js', 'ui.html']) {
    let contents = name === 'ui.html' ? html.replace(marker, `const installationToken = '${token}';`)
      : await readFile(join(root, 'plugin', name));
    if (name === 'manifest.json') {
      const manifest = JSON.parse(contents.toString());
      manifest.id += '-auto';
      manifest.name += ' Auto';
      contents = JSON.stringify(manifest, null, 2) + '\n';
    }
    await writeFile(join(target, name), contents, { mode: 0o600 });
    await chmod(join(target, name), 0o600);
  }
  return join(target, 'manifest.json');
}
