import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm, realpath, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readAssetAccess, readAllowedAsset, updateAssetAccess } from '../src/asset-access.mjs';

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'figma access $ space-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const assets = join(root, 'assets'), outside = join(root, 'assets-other');
  await mkdir(assets); await mkdir(outside);
  return { root, assets, outside };
}

test('asset access denies by default and persists only explicitly selected directories', async t => {
  const { root, assets } = await fixture(t);
  const file = join(assets, 'image'); await writeFile(file, 'hello');
  assert.deepEqual((await readAssetAccess(root)).allowedRoots, []);
  await assert.rejects(readAllowedAsset(file, 100), /disabled/);
  await updateAssetAccess(root, 'allow', assets);
  await updateAssetAccess(root, 'allow', assets);
  assert.deepEqual((await readAssetAccess(root)).allowedRoots, [assets]);
  assert.equal((await readAllowedAsset(file, 100, [assets])).toString(), 'hello');
  await updateAssetAccess(root, 'remove', assets);
  assert.deepEqual((await readAssetAccess(root)).allowedRoots, []);
});

test('path boundaries reject sibling prefixes, traversal and external symlink targets', async t => {
  const { root, assets, outside } = await fixture(t);
  const file = join(outside, 'private'); await writeFile(file, 'private');
  await symlink(outside, join(assets, 'escape'), 'junction');
  await symlink(file, join(assets, 'escape-file'));
  for (const path of [file, join(assets, '..', 'assets-other', 'private'), join(assets, 'escape/private'), join(assets, 'escape-file')]) {
    await assert.rejects(readAllowedAsset(path, 100, [assets]), /outside/);
  }
  await writeFile(join(assets, 'safe'), 'safe');
  await symlink(join(assets, 'safe'), join(assets, 'alias'));
  assert.equal((await readAllowedAsset(join(assets, 'alias'), 100, [assets])).toString(), 'safe');
  await rename(assets, join(root, 'old-assets'));
  await symlink(outside, assets, 'junction');
  await assert.rejects(readAllowedAsset(join(assets, 'private'), 100, [assets]), /outside|changed/);
});

test('bounded reads reject oversized files, directories and special files without hanging', async t => {
  const { assets } = await fixture(t);
  const file = join(assets, 'large'); await writeFile(file, Buffer.alloc(101));
  await assert.rejects(readAllowedAsset(file, 100, [assets]), /at most/);
  await assert.rejects(readAllowedAsset(assets, 100, [assets]), /regular file/);
  await assert.rejects(readAllowedAsset('relative.png', 100, [assets]), /absolute/);
  if (process.platform !== 'win32') {
    const pipe = join(assets, 'pipe');
    assert.equal(spawnSync('mkfifo', [pipe]).status, 0);
    await assert.rejects(readAllowedAsset(pipe, 100, [assets]), /regular file/);
  }
});

test('asset access CLI works from another directory and revokes deleted directories', async t => {
  const { root, assets } = await fixture(t);
  const cli = new URL('../scripts/asset-access.mjs', import.meta.url);
  const run = (...args) => spawnSync(process.execPath, [cli.pathname, '--package-root', root, ...args], { cwd: tmpdir(), encoding: 'utf8' });
  const add = run('--allow', assets);
  assert.equal(add.status, 0, add.stderr);
  assert.deepEqual(JSON.parse(add.stdout).allowedRoots, [assets]);
  const policy = await readFile(join(root, 'generated/asset-access.json'), 'utf8');
  assert.equal(run('--list').status, 0);
  assert.equal(await readFile(join(root, 'generated/asset-access.json'), 'utf8'), policy);
  await rm(assets, { recursive: true });
  assert.equal(run('--remove', assets).status, 0);
  assert.deepEqual((await readAssetAccess(root)).allowedRoots, []);
  assert.notEqual(run('--allow', 'relative').status, 0);
});

test('malformed asset policy fails closed', async t => {
  const { root } = await fixture(t); await mkdir(join(root, 'generated'));
  for (const contents of ['broken', '{"version":2,"allowedRoots":[]}', '{"version":1,"allowedRoots":["."]}']) {
    await writeFile(join(root, 'generated/asset-access.json'), contents);
    await assert.rejects(readAssetAccess(root));
  }
});
