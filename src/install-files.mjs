import { cp, lstat, mkdir, readFile, readdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export async function regularFiles(root, prefix = '') {
  const stat = await lstat(root);
  if (stat.isSymbolicLink()) throw new Error(`Symlink in installation: ${prefix || root}`);
  if (stat.isFile()) return [prefix];
  if (!stat.isDirectory()) throw new Error(`Not a regular installation entry: ${prefix || root}`);
  const files = [];
  for (const name of (await readdir(root)).sort()) files.push(...await regularFiles(join(root, name), prefix ? `${prefix}/${name}` : name));
  return files;
}

// The mutable runtime root stays in place. Each published file is complete,
// and rollback only touches files that were actually replaced by this attempt.
export function createFileTransaction({ target, staged, backup, files, recovery, move = rename }) {
  const replaced = [];
  return {
    async apply() {
      for (const name of files) {
        if (!name || name.includes('\\') || name.includes(':') || name.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('Invalid installation path');
        await mkdir(dirname(join(target, name)), { recursive: true, mode: 0o700 });
        await move(join(staged, name), join(target, name));
        replaced.push(name);
      }
    },
    async rollback() {
      for (const name of [...replaced].reverse()) {
        let exists = true;
        try { await lstat(join(backup, name)); } catch (error) { if (error.code !== 'ENOENT') throw error; exists = false; }
        if (!exists) await rm(join(target, name), { force: true });
        else {
          const restored = join(recovery, name);
          await mkdir(dirname(restored), { recursive: true, mode: 0o700 });
          await cp(join(backup, name), restored);
          await rename(restored, join(target, name));
        }
      }
    },
  };
}

export async function compareFiles(source, target, files) {
  for (const name of files) {
    // Reject redirected parents as well as a symlinked leaf.
    let path = target;
    for (const part of name.split('/')) {
      path = join(path, part);
      if ((await lstat(path)).isSymbolicLink()) throw new Error(`Symlink in installation: ${name}`);
    }
    if (!(await readFile(join(source, name))).equals(await readFile(path))) throw new Error(`Installation differs from skill: ${name}. Run install.mjs --update.`);
  }
}
