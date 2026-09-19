import { cp, lstat, mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { runtimeEntries } from '../src/package-layout.mjs';

async function assertNoSymlinks(path) {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) throw new Error(`Symlink in inspectable runtime: ${path}`);
  if (!metadata.isDirectory()) return;
  for (const name of await readdir(path)) await assertNoSymlinks(join(path, name));
}

export async function packageSkill(root) {
  const skillRoot = join(root, 'skills', 'figma-local-design');
  for (const entry of runtimeEntries) await assertNoSymlinks(join(root, entry));
  for (const entry of runtimeEntries) {
    const destination = join(skillRoot, entry);
    await rm(destination, { recursive: true, force: true });
    await mkdir(join(destination, '..'), { recursive: true });
    await cp(join(root, entry), destination, { recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true });
  }
}
