import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { hash } from '../scripts/release-files.mjs';
import { updateLocal } from '../scripts/update-local.mjs';
import { verifyInstallation } from '../scripts/verify-install.mjs';
import { prepareLocalPlugin } from '../scripts/local-plugin.mjs';
import { createDiagnostics } from '../src/diagnostics.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'figma-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source'), home = join(root, 'codex');
  const runtime = join(home, 'figma-local-mcp'), skill = join(home, 'skills/figma-local-design');
  async function put(path, data) { await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, data); }
  const pkg = JSON.stringify({ name: 'figma-local-mcp', version: '0.1.0' });
  const files = {
    'package.json': pkg, 'runtime/server.mjs': '// new runtime',
    'plugin/ui.html': "const installationToken = '';", 'plugin/code.js': '// plugin',
    'plugin/manifest.json': JSON.stringify({ id: 'test', name: 'Test' }),
    'skills/figma-local-design/package.json': pkg, 'skills/figma-local-design/version.json': '{"version":"0.1.0"}',
    'skills/figma-local-design/SKILL.md': 'new skill',
  };
  for (const [name, value] of Object.entries(files)) await put(join(source, name), value);
  await put(join(source, 'dist/release-0.1.0.json'), JSON.stringify({ format: 1, version: '0.1.0', artifacts: [], files: Object.fromEntries(Object.entries(files).map(([name, value]) => [name, hash(value)])) }));
  for (const [name, value] of Object.entries({ 'package.json': pkg, '.skill-install.json': '{"format":"figma-local-install-v2","version":"0.1.0"}', 'runtime/server.mjs': '// old runtime',
    'generated/pairing-key.json': JSON.stringify({ token: 'a'.repeat(64) }), 'generated/asset-access.json': '{"version":1,"allowedRoots":[]}' })) await put(join(runtime, name), value);
  for (const [name, value] of Object.entries({ 'package.json': pkg, 'SKILL.md': 'old skill', 'installation.json': JSON.stringify({ packageRoot: runtime, customSetting: 'preserve me' }), '.skillstore-meta.json': '{"version":6}' })) await put(join(skill, name), value);
  await put(join(home, 'config.toml'), '# unchanged configuration');
  return { source, home, runtime, skill, put, options: { source, codexHome: home, verify: async () => ({ testVerification: true }) } };
}

test('local update deploys changed bytes at the same version and preserves state and backups', async t => {
  const f = await fixture(t);
  const result = await updateLocal(f.options);
  assert.equal(await readFile(join(f.runtime, 'runtime/server.mjs'), 'utf8'), '// new runtime');
  assert.equal(await readFile(join(f.skill, 'SKILL.md'), 'utf8'), 'new skill');
  assert.equal(await readFile(join(result.runtimeBackup, 'runtime/server.mjs'), 'utf8'), '// old runtime');
  assert.equal(await readFile(join(result.skillBackup, 'SKILL.md'), 'utf8'), 'old skill');
  for (const path of ['generated/pairing-key.json', 'generated/asset-access.json']) assert.deepEqual(await readFile(join(f.runtime, path)), await readFile(join(result.runtimeBackup, path)));
  assert.deepEqual(await readFile(join(f.skill, '.skillstore-meta.json')), await readFile(join(result.skillBackup, '.skillstore-meta.json')));
  assert.equal(JSON.parse(await readFile(join(f.skill, 'installation.json'), 'utf8')).customSetting, 'preserve me');
  assert.equal(await readFile(join(f.home, 'config.toml'), 'utf8'), '# unchanged configuration');
  assert.equal(result.liveFigmaVerification, 'pending_restart');
});

test('staging verification failure leaves both installed copies unchanged', async t => {
  const f = await fixture(t);
  await assert.rejects(updateLocal({ ...f.options, verify: async () => { throw new Error('bad MCP'); } }), /bad MCP/);
  assert.equal(await readFile(join(f.runtime, 'runtime/server.mjs'), 'utf8'), '// old runtime');
  assert.equal(await readFile(join(f.skill, 'SKILL.md'), 'utf8'), 'old skill');
  await updateLocal(f.options); // A failed check must release its lock.
});

test('failure promoting the second copy rolls back both directories', async t => {
  const f = await fixture(t);
  await assert.rejects(updateLocal({ ...f.options, move: async (from, to) => {
    if (to === f.skill) throw new Error('simulated locked file');
    await rename(from, to);
  } }), /previous runtime and skill restored/);
  assert.equal(await readFile(join(f.runtime, 'runtime/server.mjs'), 'utf8'), '// old runtime');
  assert.equal(await readFile(join(f.skill, 'SKILL.md'), 'utf8'), 'old skill');
});

for (const failSkill of [false, true]) test(`runtime logging during replacement preserves the live directory (${failSkill ? 'rollback' : 'success'})`, async t => {
  const f = await fixture(t), inode = (await stat(f.runtime)).ino;
  const logger = createDiagnostics({ directory: join(f.runtime, 'generated/logs') });
  let writes = 0;
  const run = updateLocal({ ...f.options, move: async (from, to) => {
    assert.notEqual(from, f.runtime, 'the mutable runtime root must never be moved');
    logger.record('info', 'mcp_client_connected'); writes++;
    // A policy edit after staging must also survive publication and rollback.
    await writeFile(join(f.runtime, 'generated/asset-access.json'), '{"version":1,"allowedRoots":[],"changed":true}');
    if (failSkill && to === f.skill) throw new Error('simulated skill promotion failure');
    await rename(from, to);
    logger.record('info', 'operation_result');
  } });
  if (failSkill) await assert.rejects(run, /previous runtime and skill restored/);
  else await run;
  assert.ok(writes > 3);
  assert.equal((await stat(f.runtime)).ino, inode);
  assert.equal(await readFile(join(f.runtime, 'runtime/server.mjs'), 'utf8'), failSkill ? '// old runtime' : '// new runtime');
  assert.equal(await readFile(join(f.skill, 'SKILL.md'), 'utf8'), failSkill ? 'old skill' : 'new skill');
  assert.equal(JSON.parse(await readFile(join(f.runtime, 'generated/asset-access.json'))).changed, true);
  assert.ok(logger.read().entries.some(entry => entry.event === 'operation_result'));
  await assert.rejects(readFile(join(f.home, '.figma-local-update.lock')), { code: 'ENOENT' });
});

test('a failure midway through runtime replacement restores old bytes and removes added files', async t => {
  const f = await fixture(t);
  await assert.rejects(updateLocal({ ...f.options, move: async (from, to) => {
    if (to === join(f.runtime, 'plugin/code.js')) throw new Error('file locked');
    await rename(from, to);
  } }), /previous runtime and skill restored/);
  assert.equal(await readFile(join(f.runtime, 'runtime/server.mjs'), 'utf8'), '// old runtime');
  await assert.rejects(readFile(join(f.runtime, 'plugin/ui.html')), { code: 'ENOENT' });
  assert.equal(await readFile(join(f.skill, 'SKILL.md'), 'utf8'), 'old skill');
});

test('modified release files and unsafe manifest paths fail before replacement', async t => {
  const f = await fixture(t);
  await writeFile(join(f.source, 'runtime/server.mjs'), 'tampered');
  await assert.rejects(updateLocal(f.options), /checksum mismatch/);
  const path = join(f.source, 'dist/release-0.1.0.json'), manifest = JSON.parse(await readFile(path));
  manifest.files['../escape'] = 'a'.repeat(64); await writeFile(path, JSON.stringify(manifest));
  await assert.rejects(updateLocal(f.options), /Unsafe release manifest/);
  assert.equal(await readFile(join(f.runtime, 'runtime/server.mjs'), 'utf8'), '// old runtime');
});

test('foreign installations and concurrent update locks are rejected', async t => {
  const f = await fixture(t);
  await writeFile(join(f.runtime, '.skill-install.json'), '{}');
  await assert.rejects(updateLocal(f.options), /not a managed installation/);
  await writeFile(join(f.home, '.figma-local-update.lock'), 'another process');
  await assert.rejects(updateLocal(f.options), /update is locked/);
  assert.equal(await readFile(join(f.home, '.figma-local-update.lock'), 'utf8'), 'another process');
});

test('a concurrent asset-policy change cancels the update without overwriting it', async t => {
  const f = await fixture(t);
  await assert.rejects(updateLocal({ ...f.options, verify: async () => {
    await writeFile(join(f.runtime, 'generated/asset-access.json'), '{"changed":true}'); return {};
  } }), /state changed/);
  assert.equal(await readFile(join(f.runtime, 'generated/asset-access.json'), 'utf8'), '{"changed":true}');
  assert.equal(await readFile(join(f.skill, 'SKILL.md'), 'utf8'), 'old skill');
});

test('the staged bundled MCP and generated plugin pass the real installation check', async t => {
  const root = await mkdtemp(join(tmpdir(), 'figma-staged-smoke-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = new URL('../', import.meta.url);
  for (const name of ['runtime', 'plugin', 'package.json']) await cp(new URL(name, source), join(root, name), { recursive: true });
  const skill = join(root, 'skill'); await mkdir(skill);
  for (const name of ['package.json', 'version.json']) await cp(new URL('skills/figma-local-design/' + name, source), join(skill, name));
  await prepareLocalPlugin(root);
  const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const result = await verifyInstallation(root, skill, version);
  assert.equal(result.serverVersion, version); assert.equal(result.pluginVersion, version);
  assert.equal(result.pairingSecretAbsent, true); assert.ok(result.toolCount >= 32);
});
