import { readFile, writeFile, mkdir, readdir, lstat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

export async function packageSkill(root) {
  const entries = [];
  async function add(path) {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new Error('Symlink in skill payload: ' + path);
    if (stat.isDirectory()) {
      for (const name of (await readdir(path)).sort()) {
        if (name !== '__pycache__' && !name.endsWith('.pyc')) await add(join(path, name));
      }
    } else entries.push({ path: relative(root, path).split('\\').join('/'), data: (await readFile(path)).toString('base64') });
  }
  // Deliberately exclude skills/ to avoid recursive payloads, and generated/ for local secrets.
  for (const path of ['package.json', 'package-lock.json', 'build.mjs', 'tsconfig.json', 'README.md', 'INSTALL.md',
    'CUSTOMIZE.md', 'CONTRIBUTING.md', 'codex.example.toml', '.gitignore', '.mcp.json', '.codex-plugin',
    'src', 'plugin', 'runtime', 'scripts', 'test', 'examples']) await add(join(root, path));
  const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const buffer = gzipSync(JSON.stringify({ format: 'figma-local-runtime-v1', version, files: entries }), { level: 9 });
  const assets = join(root, 'skills/figma-local-design/assets');
  await mkdir(assets, { recursive: true });
  await writeFile(join(assets, 'runtime-payload.json.gz'), buffer);
  await writeFile(join(assets, 'runtime-release.json'), JSON.stringify({ version, sha256: createHash('sha256').update(buffer).digest('hex') }, null, 2) + '\n');
}
