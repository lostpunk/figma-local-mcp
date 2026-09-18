import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm, symlink, cp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadProjectRules } from '../src/project-config.mjs';
const fixture = async t => {
  const root = await mkdtemp(join(tmpdir(), 'figma-rules-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
};
const config = (root, value) => writeFile(join(root, '.figma-design.json'), JSON.stringify(value));

test('missing configuration is explicit; legacy example and selected rule files are supported', async t => {
  const root = await fixture(t);
  assert.equal((await loadProjectRules(root)).status, 'missing');
  const example = JSON.parse(await readFile('skills/figma-local-design/assets/design.config.example.json', 'utf8'));
  delete example.schemaVersion;
  await mkdir(join(root, 'design'));
  await writeFile(join(root, 'design/rules.md'), 'Use existing components.');
  await config(root, { ...example, rulesFiles: ['design/rules.md'] });
  const result = await loadProjectRules(root);
  assert.equal(result.config.schemaVersion, 1);
  assert.equal(result.ruleFiles[0].text, 'Use existing components.');
  assert.deepEqual(result.guidePatch.spacing[0], { name: '4', value: 4 });
  assert.equal(result.guidePatch.colors, undefined);
});

test('invalid policy fields, paths, symlinks and missing selected files are rejected', async t => {
  const root = await fixture(t);
  await config(root, { grid: { columns: 0, gutter: 24, margin: 64 } });
  await assert.rejects(loadProjectRules(root), /grid.columns/);
  await config(root, { foundation: { name: 'A', colours: [] } });
  await assert.rejects(loadProjectRules(root), /Unrecognized key/);
  await config(root, { library: { name: 'Kit', mode: 'local-components' } });
  await assert.rejects(loadProjectRules(root), /library.components/);
  await config(root, { rulesFiles: ['../outside.md'] });
  await assert.rejects(loadProjectRules(root), /project-relative/);
  await config(root, { rulesFiles: ['missing.md'] });
  await assert.rejects(loadProjectRules(root), /ENOENT/);
  const outside = await fixture(t);
  await writeFile(join(outside, 'rules.md'), 'Outside');
  await symlink(join(outside, 'rules.md'), join(root, 'linked.md'));
  await config(root, { rulesFiles: ['linked.md'] });
  await assert.rejects(loadProjectRules(root), /escapes/);
});

test('standalone project-rules CLI works without node_modules and does not modify project files', async t => {
  const root = await fixture(t);
  const cli = join(root, 'project-rules.mjs');
  await cp('skills/figma-local-design/scripts/project-rules.mjs', cli);
  await config(root, { foundation: { name: 'Brand', colors: [{ name: 'surface', value: '#ffffff' }] }, componentStates: { Button: ['default', 'hover', 'focus'] } });
  const before = await readFile(join(root, '.figma-design.json'), 'utf8');
  const run = spawnSync(process.execPath, [cli, '--project', root], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).guidePatch.colors[0].value, '#ffffff');
  assert.equal(await readFile(join(root, '.figma-design.json'), 'utf8'), before);
  await config(root, { library: { name: 'Untrusted', mode: 'reference', docs: 'https://arbitrary.example/docs' } });
  const rejected = spawnSync(process.execPath, [cli, '--project', root], { encoding: 'utf8' });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /library.docs/);
});

test('project documentation URLs enforce exact HTTPS hosts and expose reading constraints', async t => {
  const root = await fixture(t);
  const library = { name: 'Kit', mode: 'reference' };
  for (const docs of ['https://ui.shadcn.com/docs', 'https://gravity-ui.com/components/uikit/button', 'https://developers.figma.com/docs/plugins/#intro']) {
    await config(root, { library: { ...library, docs } });
    const result = await loadProjectRules(root);
    assert.equal(result.documentation.url, docs);
    assert.match(result.documentation.beforeRead, /Show this URL/);
    assert.match(result.documentation.beforeRead, /every redirect/);
    assert.match(result.instructions, /untrusted design input/);
  }
  for (const docs of ['http://gravity-ui.com/', 'https://gravity-ui.com.evil.test/', 'https://sub.gravity-ui.com/',
    'https://gravity-ui.com@evil.test/', 'https://user:secret@gravity-ui.com/', 'https://127.0.0.1/',
    'https://gravity-ui.com:8443/', 'https://gravity-ui.com/?redirect=https://evil.test/', 'https://gravity-ui.com./',
    'file:///tmp/docs', 'https://gravity-ui.com/\nsecret', 'https://gravity-ui.com\\@evil.test/']) {
    await config(root, { library: { ...library, docs } });
    await assert.rejects(loadProjectRules(root), /library.docs/);
  }
  await config(root, { library: { name: 'Internal kit', mode: 'reference' } });
  assert.equal((await loadProjectRules(root)).documentation, null);
});

test('explicit project audit rules round-trip without adding implicit allowlists', async t => {
  const root = await fixture(t);
  const designSystem = { colorVariableIds: ['VariableID:1'], textStyleIds: ['style:1'], componentIds: ['1:2'], ignoreNodeIds: ['1:3'] };
  await config(root, { foundation: { name: 'Brand', spacing: [8, 16] }, audit: { designSystem } });
  assert.deepEqual((await loadProjectRules(root)).auditRules, { spacing: [8, 16], designSystem });
  await config(root, {}); assert.deepEqual((await loadProjectRules(root)).auditRules, {});
  await config(root, { audit: { designSystem: { colors: ['red'] } } });
  await assert.rejects(loadProjectRules(root), /Unrecognized key/);
});
