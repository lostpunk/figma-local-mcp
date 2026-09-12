import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, writeFile, readdir, rm, realpath, chmod, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { z } from 'zod';
import { guideSchema } from '../src/design-schema.mjs';

async function fixture(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "figma setup ' $ space-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'package');
  await mkdir(root);
  for (const path of ['scripts/setup.mjs', 'scripts/local-plugin.mjs', 'src/pairing.mjs', 'plugin/code.js', 'plugin/ui.html', 'plugin/manifest.json', 'runtime/server.mjs']) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await cp(new URL('../' + path, import.meta.url), join(root, path));
  }
  await cp(new URL('../skills/', import.meta.url), join(root, 'skills'), { recursive: true });
  const skillDirectory = join(directory, 'installed-skills');
  const env = { ...process.env, FIGMA_LOCAL_SKILL_DIR: skillDirectory };
  const run = (...args) => spawnSync(process.execPath, [join(root, 'scripts/setup.mjs'), ...args], {
    encoding: 'utf8', cwd: directory, env,
  });
  return { root, skillDirectory, run, env, directory };
}

test('setup emits literal portable paths and does not install by default', async t => {
  const { root, skillDirectory, run } = await fixture(t);
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(await readFile(join(root, 'generated/mcp.json'), 'utf8'));
  assert.equal(config.mcpServers.figma_local.command, process.execPath);
  assert.deepEqual(config.mcpServers.figma_local.args, [join(root, 'runtime/server.mjs')]);
  await assert.rejects(readdir(skillDirectory), { code: 'ENOENT' });
});

test('setup generates private automatic plugin and preserves its key across updates', async t => {
  const { root, run } = await fixture(t);
  assert.equal(run().status, 0);
  const keyPath = join(root, 'generated/pairing-key.json');
  const key = JSON.parse(await readFile(keyPath, 'utf8')).token;
  assert.match(key, /^[a-f0-9]{64}$/);
  const htmlPath = join(root, 'generated/figma-plugin/ui.html');
  const manifest = JSON.parse(await readFile(join(root, 'generated/figma-plugin/manifest.json'), 'utf8'));
  const manual = JSON.parse(await readFile(join(root, 'plugin/manifest.json'), 'utf8'));
  assert.notEqual(manifest.id, manual.id);
  assert.equal(manifest.name, 'Figma Local MCP Auto');
  assert.ok((await readFile(htmlPath, 'utf8')).includes(`const installationToken = '${key}';`));
  assert.ok(!(await readFile(join(root, 'plugin/ui.html'), 'utf8')).includes(key));
  const next = run();
  assert.equal(next.status, 0, next.stderr);
  assert.ok(!next.stdout.includes(key));
  assert.equal(JSON.parse(await readFile(keyPath, 'utf8')).token, key);
  if (process.platform !== 'win32') {
    assert.equal((await stat(keyPath)).mode & 0o777, 0o600);
    assert.equal((await stat(htmlPath)).mode & 0o777, 0o600);
  }
  await writeFile(keyPath, '{"token":"bad"}');
  assert.notEqual(run().status, 0);
});

test('skill installer refuses overwrite and explicit update preserves a backup', async t => {
  const { root, skillDirectory, run } = await fixture(t);
  const first = run('--install-skill');
  assert.equal(first.status, 0, first.stderr);
  const skill = join(skillDirectory, 'figma-local-design');
  assert.equal(JSON.parse(await readFile(join(skill, 'installation.json'), 'utf8')).packageRoot, root);
  await writeFile(join(skill, 'custom.md'), 'User customization');
  assert.notEqual(run('--install-skill').status, 0);
  assert.equal(await readFile(join(skill, 'custom.md'), 'utf8'), 'User customization');
  const update = run('--install-skill', '--update-skill');
  assert.equal(update.status, 0, update.stderr);
  const backup = (await readdir(join(root, 'generated'))).find(name => name.startsWith('figma-local-design-backup-'));
  assert.ok(backup);
  assert.equal(await readFile(join(root, 'generated', backup, 'custom.md'), 'utf8'), 'User customization');
  assert.deepEqual(await readdir(skillDirectory), ['figma-local-design']);
});

test('shadcn starter is valid input for the implemented style-guide tool', async () => {
  const starter = JSON.parse(await readFile(new URL('../skills/figma-local-design/assets/shadcn-starter.json', import.meta.url), 'utf8'));
  const parsed = z.object(guideSchema).parse(starter);
  assert.ok(parsed.colors.some(token => token.name === 'primary-foreground'));
  assert.equal(parsed.typography.length, 5);
});

test('Codex registration passes literal arguments and preserves a conflicting registration', { skip: process.platform === 'win32' }, async t => {
  const { root, skillDirectory, run, env, directory } = await fixture(t);
  const bin = join(directory, 'bin');
  const registry = join(directory, 'fake-registry.json');
  await mkdir(bin);
  await writeFile(registry, '[]');
  const executable = join(bin, 'codex');
  await writeFile(executable, `#!${process.execPath}\n` + `
const fs = require('node:fs');
const path = process.env.FIGMA_TEST_REGISTRY;
const args = process.argv.slice(2);
if (args[0] !== 'mcp') process.exit(2);
if (args[1] === 'list') process.stdout.write(fs.readFileSync(path, 'utf8'));
else if (args[1] === 'add' && args[2] === 'figma_local' && args[3] === '--') {
  fs.writeFileSync(path, JSON.stringify([{ name: args[2], enabled: true, transport: { type: 'stdio', command: args[4], args: args.slice(5) } }]));
} else process.exit(3);
`);
  await chmod(executable, 0o755);
  env.PATH = bin + delimiter + process.env.PATH;
  env.FIGMA_TEST_REGISTRY = registry;
  const installed = run('--codex');
  assert.equal(installed.status, 0, installed.stderr);
  const registered = JSON.parse(await readFile(registry, 'utf8'))[0];
  assert.deepEqual(registered.transport.args, [join(root, 'runtime/server.mjs')]);
  assert.ok(await readFile(join(skillDirectory, 'figma-local-design/SKILL.md'), 'utf8'));
  const conflict = [{ ...registered, transport: { command: 'different', args: [] } }];
  await writeFile(registry, JSON.stringify(conflict));
  assert.notEqual(run('--codex', '--update-skill').status, 0);
  assert.deepEqual(JSON.parse(await readFile(registry, 'utf8')), conflict);
});
