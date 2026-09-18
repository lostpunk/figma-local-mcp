import test from 'node:test';
import assert from 'node:assert/strict';
import { access, chmod, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile, rename, stat } from 'node:fs/promises';
import { join, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createDiagnostics } from '../src/diagnostics.mjs';
import { installEmbedded } from '../skills/figma-local-design/scripts/install.mjs';

const source = new URL('../', import.meta.url);

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "figma bootstrap ' $ space-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const skillRoot = join(directory, 'skill');
  await cp(new URL('../skills/figma-local-design/', import.meta.url), skillRoot, { recursive: true });
  for (const entry of ['package.json', 'runtime', 'plugin', 'src']) {
    await cp(new URL(`../${entry}`, import.meta.url), join(skillRoot, entry), { recursive: true });
  }
  for (const name of ['setup.mjs', 'local-plugin.mjs']) {
    await cp(new URL(`../scripts/${name}`, import.meta.url), join(skillRoot, 'scripts', name));
  }
  await rm(join(skillRoot, 'installation.json'), { force: true });
  return { directory, skillRoot, target: join(directory, 'runtime') };
}

test('standalone skill installs inspectable sources, preserves the key and updates with a backup', async t => {
  const f = await fixture(t);
  const env = { ...process.env, CODEX_HOME: join(f.directory, 'codex') };
  const run = (...args) => spawnSync(process.execPath, [join(f.skillRoot, 'scripts/install.mjs'), '--target', f.target, '--no-register', '--no-open', ...args], { encoding: 'utf8', env });
  const installed = run();
  assert.equal(installed.status, 0, installed.stderr);
  assert.match(installed.stdout, /needs_project/);
  const keyPath = join(f.target, 'generated/pairing-key.json');
  const key = JSON.parse(await readFile(keyPath, 'utf8')).token;
  const assetAccess = JSON.stringify({ version: 1, allowedRoots: [f.directory] });
  await writeFile(join(f.target, 'generated/asset-access.json'), assetAccess);
  const accessCli = spawnSync(process.execPath, [join(f.target, 'scripts/asset-access.mjs'), '--list'], { encoding: 'utf8' });
  assert.equal(accessCli.status, 0, accessCli.stderr);
  assert.deepEqual(JSON.parse(accessCli.stdout).allowedRoots, [f.directory]);
  assert.ok((await readFile(join(f.target, 'generated/figma-plugin/ui.html'), 'utf8')).includes(key));
  assert.equal(run().status, 0);
  assert.equal(JSON.parse(await readFile(keyPath, 'utf8')).token, key);
  assert.equal(JSON.parse(await readFile(join(f.skillRoot, 'installation.json'), 'utf8')).packageRoot, f.target);
  const pkg = JSON.parse(await readFile(join(f.skillRoot, 'package.json'), 'utf8'));
  await writeFile(join(f.target, 'package.json'), JSON.stringify({ ...pkg, version: '0.6.3' }) + '\n');
  await writeFile(join(f.target, '.skill-install.json'), JSON.stringify({ format: 'figma-local-install-v1', version: '0.6.3' }) + '\n');
  const updated = run('--update');
  assert.equal(updated.status, 0, updated.stderr);
  assert.equal(await readFile(join(f.target, 'generated/asset-access.json'), 'utf8'), assetAccess);
  assert.equal(JSON.parse(await readFile(keyPath, 'utf8')).token, key);
  assert.equal(JSON.parse(await readFile(join(f.target, 'package.json'), 'utf8')).version, pkg.version);
  assert.equal(JSON.parse(await readFile(join(f.target, '.skill-install.json'), 'utf8')).format, 'figma-local-install-v2');
  assert.match(updated.stdout, /Previous installation backed up to:/);
});

test('installer offers project onboarding and preserves the selected design on reuse', async t => {
  const f = await fixture(t);
  const project = join(f.directory, 'project');
  await mkdir(project);
  const answers = join(f.directory, 'answers.json');
  await writeFile(answers, JSON.stringify({ designSystem: 'shadcn-ui', theme: 'dark' }));
  const run = (...args) => spawnSync(process.execPath, [join(f.skillRoot, 'scripts/install.mjs'), '--target', f.target,
    '--no-register', '--no-open', '--project', project, ...args], { encoding: 'utf8' });
  const pending = run('--non-interactive');
  assert.equal(pending.status, 0, pending.stderr);
  assert.match(pending.stdout, /needs_input/);
  const completed = run('--design-answers', answers);
  assert.equal(completed.status, 0, completed.stderr);
  const config = await readFile(join(project, '.figma-design.json'), 'utf8');
  assert.equal(JSON.parse(config).foundation.theme, 'dark');
  assert.equal(run('--non-interactive').status, 0);
  assert.equal(await readFile(join(project, '.figma-design.json'), 'utf8'), config);
});

test('installer rejects symlinked runtime sources before changing a target', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  await rm(join(f.skillRoot, 'runtime'), { recursive: true });
  await cp(new URL('../runtime/', import.meta.url), join(f.skillRoot, 'runtime'), { recursive: true });
  await rm(join(f.skillRoot, 'runtime/server.mjs'));
  await import('node:fs/promises').then(({ symlink }) => symlink(join(f.directory, 'not-a-runtime'), join(f.skillRoot, 'runtime/server.mjs')));
  await assert.rejects(installEmbedded({ source: f.skillRoot, target: f.target }), /incomplete|symlink/i);
  await assert.rejects(access(f.target), { code: 'ENOENT' });
});

test('standalone installer registers MCP without reinstalling or overwriting the skill', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  const bin = join(f.directory, 'bin');
  const registry = join(f.directory, 'registry.json');
  await mkdir(bin);
  await writeFile(registry, '[]');
  await writeFile(join(f.skillRoot, 'custom-rule.md'), 'Keep my rules');
  await writeFile(join(bin, 'codex'), `#!${process.execPath}\n` + `
const fs=require('node:fs');
const args=process.argv.slice(2), path=process.env.FIGMA_TEST_REGISTRY;
if(args[1]==='list')process.stdout.write(fs.readFileSync(path,'utf8'));
else if(args[1]==='add')fs.writeFileSync(path,JSON.stringify([{name:args[2],enabled:true,transport:{command:args[4],args:args.slice(5)}}]));
else process.exit(2);
`);
  await chmod(join(bin, 'codex'), 0o755);
  const result = spawnSync(process.execPath, [join(f.skillRoot, 'scripts/install.mjs'), '--target', f.target, '--no-open'], {
    encoding: 'utf8', env: { ...process.env, CODEX_HOME: join(f.directory, 'codex'), PATH: bin + delimiter + process.env.PATH, FIGMA_TEST_REGISTRY: registry },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(await readFile(registry, 'utf8'))[0].transport.args, [await realpath(join(f.target, 'runtime/server.mjs'))]);
  assert.equal(await readFile(join(f.skillRoot, 'custom-rule.md'), 'utf8'), 'Keep my rules');
});

for (const fail of [false, true]) test(`standalone update keeps live logs and private state (${fail ? 'rollback' : 'success'})`, async t => {
  const f = await fixture(t);
  await installEmbedded({ source: f.skillRoot, target: f.target });
  const inode = (await stat(f.target)).ino;
  const key = await readFile(join(f.target, 'generated/pairing-key.json'));
  const manifestPath = join(f.target, 'generated/figma-plugin/manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath)); manifest.id = 'my-issued-figma-id';
  await writeFile(manifestPath, JSON.stringify(manifest));
  const policy = '{"version":1,"allowedRoots":[]}'; await writeFile(join(f.target, 'generated/asset-access.json'), policy);
  await writeFile(join(f.target, 'runtime/server.mjs'), '// prior runtime');
  const logger = createDiagnostics({ directory: join(f.target, 'generated/logs') });
  const update = installEmbedded({ source: f.skillRoot, target: f.target, update: true, move: async (from, to) => {
    assert.notEqual(from, f.target);
    logger.record('info', 'operation_result');
    if (fail && to === join(f.target, 'generated/figma-plugin/code.js')) throw new Error('simulated locked file');
    await rename(from, to);
  } });
  if (fail) await assert.rejects(update, /previous runtime restored/);
  else assert.equal((await update).synchronization.disk, 'verified');
  assert.equal((await stat(f.target)).ino, inode);
  assert.deepEqual(await readFile(join(f.target, 'generated/pairing-key.json')), key);
  assert.equal(await readFile(join(f.target, 'generated/asset-access.json'), 'utf8'), policy);
  assert.equal(JSON.parse(await readFile(manifestPath)).id, 'my-issued-figma-id');
  assert.ok(logger.read().entries.length > 0);
  assert.equal(await readFile(join(f.target, 'runtime/server.mjs'), 'utf8'), fail ? '// prior runtime' : await readFile(join(f.skillRoot, 'runtime/server.mjs'), 'utf8'));
});

test('standalone check detects drift, update repairs same-version files and preserves locator metadata', async t => {
  const f = await fixture(t);
  const run = (...args) => spawnSync(process.execPath, [join(f.skillRoot, 'scripts/install.mjs'), '--no-register', '--no-open', '--non-interactive', ...args], { encoding: 'utf8' });
  assert.equal(run('--target', f.target).status, 0);
  const locator = join(f.skillRoot, 'installation.json');
  await writeFile(locator, JSON.stringify({ packageRoot: f.target, custom: 'preserved' }));
  await writeFile(join(f.skillRoot, '.skillstore-meta.json'), '{"version":6}');
  assert.equal(run('--check').status, 0);
  await writeFile(join(f.target, 'runtime/server.mjs'), '// stale runtime');
  const checked = run('--check'); assert.notEqual(checked.status, 0); assert.match(checked.stderr, /differs/);
  const skipped = run(); assert.notEqual(skipped.status, 0, 'existing locator must not hide an outdated runtime');
  const updated = run('--update'); assert.equal(updated.status, 0, updated.stderr);
  assert.match(updated.stdout, /restart_required/);
  assert.equal(JSON.parse(await readFile(locator)).custom, 'preserved');
  assert.equal(await readFile(join(f.skillRoot, '.skillstore-meta.json'), 'utf8'), '{"version":6}');
  assert.equal(run('--check').status, 0);
});

test('broken staged runtime and concurrent updates cannot replace a working installation', async t => {
  const f = await fixture(t);
  await installEmbedded({ source: f.skillRoot, target: f.target });
  const original = await readFile(join(f.target, 'runtime/server.mjs'));
  await writeFile(join(f.skillRoot, 'runtime/server.mjs'), 'this is invalid javascript');
  await assert.rejects(installEmbedded({ source: f.skillRoot, target: f.target, update: true }), /installation check failed/);
  assert.deepEqual(await readFile(join(f.target, 'runtime/server.mjs')), original);
  await writeFile(join(f.directory, '.figma-local-update.lock'), 'another updater');
  await assert.rejects(installEmbedded({ source: f.skillRoot, target: f.target, update: true }), /Another installation/);
});
