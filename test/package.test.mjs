import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../', import.meta.url));
const ignoredDirectories = new Set(['.git', 'dist', 'generated', 'node_modules']);

test('portable archives exclude local SkillStore metadata', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'figma-package-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'figma-local-mcp');
  await cp(source, root, { recursive: true, filter: path => !ignoredDirectories.has(basename(path)) });
  await writeFile(join(root, 'skills/figma-local-design/.skillstore-meta.json'), '{"local":true}\n');

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
});
