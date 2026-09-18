import { mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

const policyPath = root => join(root, 'generated', 'asset-access.json');
const within = (root, path) => {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

export async function readAssetAccess(packageRoot) {
  let raw;
  try { raw = await readFile(policyPath(packageRoot), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return { version: 1, allowedRoots: [] }; throw error; }
  if (Buffer.byteLength(raw) > 65536) throw new Error('Invalid asset-access policy: exceeds 64 KiB');
  const policy = JSON.parse(raw);
  if (policy?.version !== 1 || !Array.isArray(policy.allowedRoots) || policy.allowedRoots.length > 32 ||
      !policy.allowedRoots.every(path => typeof path === 'string' && isAbsolute(path) && path.length <= 4096)) {
    throw new Error('Invalid asset-access policy; configure it with scripts/asset-access.mjs');
  }
  return { version: 1, allowedRoots: [...new Set(policy.allowedRoots)] };
}

export async function updateAssetAccess(packageRoot, action, directory) {
  const policy = await readAssetAccess(packageRoot);
  if (!['allow', 'remove', 'clear'].includes(action)) throw new Error('Unknown asset-access action');
  if (action === 'clear') policy.allowedRoots = [];
  else {
    if (!directory || !isAbsolute(directory)) throw new Error('Use an absolute asset directory');
    if (action === 'allow') {
      const canonical = await realpath(directory);
      if (!(await stat(canonical)).isDirectory()) throw new Error('Asset root must be a directory');
      if (!policy.allowedRoots.includes(canonical)) policy.allowedRoots.push(canonical);
      if (policy.allowedRoots.length > 32) throw new Error('At most 32 asset directories are supported');
    } else {
      // A deleted directory must still be removable from the policy.
      const candidates = new Set([resolve(directory)]);
      try { candidates.add(await realpath(directory)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      policy.allowedRoots = policy.allowedRoots.filter(path => !candidates.has(path));
    }
  }
  await mkdir(join(packageRoot, 'generated'), { recursive: true, mode: 0o700 });
  const temporary = `${policyPath(packageRoot)}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(policy, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(temporary, policyPath(packageRoot));
  } finally { await rm(temporary, { force: true }); }
  return policy;
}

export async function readAllowedAsset(path, limit, allowedRoots = []) {
  if (!isAbsolute(path)) throw new Error('Asset path must be an absolute local path');
  if (!allowedRoots.length) throw new Error('Local file import is disabled. Select an asset directory using scripts/asset-access.mjs --allow PATH');
  const canonical = await realpath(path);
  const root = allowedRoots.find(directory => within(directory, canonical));
  if (!root) throw new Error('Asset is outside the allowed directories');
  if (await realpath(root) !== root) throw new Error('Allowed directory changed; configure asset access again');
  // O_NOFOLLOW protects the final component; post-open identity checks also catch
  // ordinary parent/symlink replacements before any bytes are read.
  const file = await open(canonical, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await file.stat();
    if (!opened.isFile() || opened.size > limit) throw new Error(`Expected a regular file of at most ${limit} bytes`);
    const currentPath = await realpath(path);
    const current = await stat(currentPath);
    if (currentPath !== canonical || !within(root, currentPath) || await realpath(root) !== root ||
        current.dev !== opened.dev || current.ino !== opened.ino) throw new Error('Asset changed while opening; retry with a stable file');
    const buffer = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > limit) throw new Error('Asset exceeds size limit');
    return buffer.subarray(0, size);
  } finally { await file.close(); }
}
