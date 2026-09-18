import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../', import.meta.url));
const ignoredDirectories = new Set(['.git', 'dist', 'generated', 'node_modules', 'artifacts', 'backups', 'private-distributions']);

test('portable archives exclude local SkillStore metadata', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'figma-package-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'figma-local-mcp');
  await cp(source, root, { recursive: true, filter: path => !ignoredDirectories.has(basename(path)) });
  await writeFile(join(root, 'skills/figma-local-design/.skillstore-meta.json'), '{"local":true}\n');
  await mkdir(join(root, 'generated/operation-history'), { recursive: true });
  await writeFile(join(root, 'generated/operation-history/port-3055.enc'), 'private-history-sentinel');

  const packaged = spawnSync('python3', [join(root, 'scripts/package.py')], { cwd: root, encoding: 'utf8' });
  assert.equal(packaged.status, 0, packaged.stderr);
  const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
  const archive = join(root, `dist/figma-local-mcp-${version}.zip`);
  const listed = spawnSync('python3', ['-c', 'import json, sys, zipfile; print(json.dumps(zipfile.ZipFile(sys.argv[1]).namelist()))', archive], { encoding: 'utf8' });
  assert.equal(listed.status, 0, listed.stderr);
  const entries = JSON.parse(listed.stdout);
  assert.ok(entries.includes('figma-local-mcp/.mcp.json'));
  assert.ok(entries.includes('figma-local-mcp/skills/figma-local-design/runtime/server.mjs'));
  assert.ok(entries.includes('figma-local-mcp/skills/figma-local-design/plugin/code.js'));
  assert.ok(entries.includes('figma-local-mcp/skills/figma-local-design/scripts/setup.mjs'));
  assert.ok(!entries.some(entry => entry.endsWith('/runtime-payload.json.gz') || entry.endsWith('/runtime-release.json')));
  assert.ok(!entries.some(entry => entry.endsWith('/.skillstore-meta.json') || entry.endsWith('/installation.json')));
  assert.ok(!entries.some(entry => entry.includes('/generated/') || entry.endsWith('.enc')));
  assert.ok(entries.includes('figma-local-mcp/skills/figma-local-design/assets/distribution.json'));
  assert.ok(entries.includes('figma-local-mcp/skills/figma-local-design/references/gravity-ui.md'));
  const first = await readFile(archive);
  const repeat = spawnSync('python3', [join(root, 'scripts/package.py')], { cwd: root, encoding: 'utf8' });
  assert.equal(repeat.status, 0, repeat.stderr);
  assert.deepEqual(await readFile(archive), first, 'identical inputs must produce identical archive bytes');
  await writeFile(archive, Buffer.concat([first, Buffer.from('tampered')]));
  const corrupted = spawnSync('python3', [join(root, 'scripts/package.py'), '--verify'], { cwd: root, encoding: 'utf8' });
  assert.notEqual(corrupted.status, 0);
  assert.match(corrupted.stderr, /checksum mismatch/);
  await writeFile(archive, first);
  await writeFile(join(root, 'plugin/ui.html'), "const installationToken = '" + 'b'.repeat(64) + "';");
  const secret = spawnSync('python3', [join(root, 'scripts/package.py')], { cwd: root, encoding: 'utf8' });
  assert.notEqual(secret.status, 0);
  assert.match(secret.stderr, /pairing secret/);
  await cp(join(source, 'plugin/ui.html'), join(root, 'plugin/ui.html'));
  await writeFile(join(root, 'skills/figma-local-design/references/distribution-profile.md'), 'Retired private profile');
  const contaminated = spawnSync('python3', [join(root, 'scripts/package.py')], { cwd: root, encoding: 'utf8' });
  assert.notEqual(contaminated.status, 0);
  assert.match(contaminated.stderr, /Forbidden/);
});

test('SkillStore package removes deep external references from generated files only', async t => {
  const packaged = spawnSync(process.execPath, [join(source, 'scripts/package-skillstore.mjs')], { cwd: source, encoding: 'utf8' });
  assert.equal(packaged.status, 0, packaged.stderr);
  const output = join(source, 'dist/skillstore/figma-local-design');
  const runtime = await readFile(join(output, 'runtime/server.mjs'), 'utf8');
  const notices = await readFile(join(output, 'runtime/THIRD_PARTY_NOTICES.md'), 'utf8');
  const deepExternalReference = /https?:\/\/[^\s<>()\[\]{}]+(?:\/(?:blob|commit)\/|#[^\s<>()\[\]{}]+)/;
  assert.doesNotMatch(runtime, deepExternalReference);
  assert.doesNotMatch(notices, deepExternalReference);
  assert.match(runtime, /createBridge/);
});
