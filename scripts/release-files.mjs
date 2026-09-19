import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
export const hash = data => createHash('sha256').update(data).digest('hex');
export const skillPrefix = 'skills/figma-local-design/';
export { isRuntimeFile } from '../src/package-layout.mjs';
export async function treeFiles(root, prefix = '') {
  const result = [];
  for (const name of (await readdir(root)).sort()) {
    const path = join(root, name), stat = await lstat(path), key = prefix + name;
    if (stat.isSymbolicLink()) throw new Error(`Symlink is not allowed: ${key}`);
    if (stat.isDirectory()) result.push(...await treeFiles(path, key + '/'));
    else if (stat.isFile()) result.push(key);
    else throw new Error(`Not a regular file: ${key}`);
  }
  return result;
}
export async function readManifest(root) {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(join(root, 'dist', `release-${pkg.version}.json`), 'utf8'));
  if (manifest.format !== 1 || manifest.version !== pkg.version || !manifest.files || !Array.isArray(manifest.artifacts)) throw new Error('Invalid release manifest');
  for (const [name, digest] of Object.entries(manifest.files)) {
    if (!name || name.includes('\\') || name.includes(':') || name.split('/').some(part => !part || part === '.' || part === '..') || !/^[a-f0-9]{64}$/.test(digest)) throw new Error('Unsafe release manifest entry');
  }
  for (const name of ['package.json', 'runtime/server.mjs', 'plugin/code.js', `${skillPrefix}SKILL.md`, `${skillPrefix}package.json`]) {
    if (!manifest.files[name]) throw new Error(`Incomplete release manifest: ${name}`);
  }
  return manifest;
}
export async function verifyFiles(root, files) {
  for (const [name, digest] of Object.entries(files)) {
    // Check directory ancestors as well as the leaf: do not follow symlinks.
    let path = root;
    for (const part of name.split('/')) {
      path = join(path, part);
      if ((await lstat(path)).isSymbolicLink()) throw new Error(`Symlink in release: ${name}`);
    }
    if (hash(await readFile(path)) !== digest) throw new Error(`Release file checksum mismatch: ${name}`);
  }
}
