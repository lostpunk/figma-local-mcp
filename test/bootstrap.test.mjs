import test from 'node:test';
import assert from 'node:assert/strict';
import { access, chmod, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
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
  const keyPath = join(f.target, 'generated/pairing-key.json');
  const key = JSON.parse(await readFile(keyPath, 'utf8')).token;
  assert.ok((await readFile(join(f.target, 'generated/figma-plugin/ui.html'), 'utf8')).includes(key));
  assert.equal(run().status, 0);
  assert.equal(JSON.parse(await readFile(keyPath, 'utf8')).token, key);
  assert.equal(JSON.parse(await readFile(join(f.skillRoot, 'installation.json'), 'utf8')).packageRoot, f.target);
  const pkg = JSON.parse(await readFile(join(f.skillRoot, 'package.json'), 'utf8'));
  pkg.version = '0.6.5';
  await writeFile(join(f.skillRoot, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  await writeFile(join(f.target, '.skill-install.json'), JSON.stringify({ format: 'figma-local-install-v1', version: '0.6.3' }) + '\n');
  const updated = run('--update');
  assert.equal(updated.status, 0, updated.stderr);
  assert.equal(JSON.parse(await readFile(keyPath, 'utf8')).token, key);
  assert.equal(JSON.parse(await readFile(join(f.target, 'package.json'), 'utf8')).version, '0.6.5');
  assert.equal(JSON.parse(await readFile(join(f.target, '.skill-install.json'), 'utf8')).format, 'figma-local-install-v2');
  assert.match(updated.stdout, /Previous installation backed up to:/);
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
