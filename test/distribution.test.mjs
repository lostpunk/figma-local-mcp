import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadDistribution } from '../src/distribution.mjs';
import { onboardProject, collectAnswers, configFromAnswers } from '../src/onboarding.mjs';

const policy = { schemaVersion: 1, id: 'team-example', label: 'Team Example UI', welcome: 'New projects use Team Example UI; you may switch.',
  defaults: { profile: 'team-example', library: { name: 'Team Example UI', mode: 'reference', components: {} },
    rules: ['Use semantic tokens from the chosen theme.'], componentStates: { Button: ['default', 'focus'] } } };
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'figma-distribution-'));
  t.after(() => rm(root, { recursive: true, force: true })); return root;
}

test('packaged default is announced and offered without writing unselected project choices', async t => {
  const root = await fixture(t);
  const result = await onboardProject({ projectRoot: root, distribution: policy });
  assert.equal(result.status, 'needs_input');
  assert.equal(result.welcome, policy.welcome);
  assert.equal(result.questions[0].defaultValue, 'distribution');
  assert.equal(result.questions[0].options[0].value, 'distribution');
  await assert.rejects(readFile(join(root, '.figma-design.json')), { code: 'ENOENT' });
  const responses = ['', '', '', '', '', '', '', ''];
  const answers = await collectAnswers(async () => responses.shift(), 'Project', policy);
  const saved = await onboardProject({ projectRoot: root, answers, distribution: policy });
  assert.equal(saved.config.library.name, policy.defaults.library.name);
  assert.deepEqual(saved.config.rules, policy.defaults.rules);
  assert.equal(saved.config.foundation.colors, undefined);
  assert.deepEqual(saved.config.componentStates, policy.defaults.componentStates);
});

test('explicit overrides and existing/deferred choices beat the distribution default', async t => {
  for (const designSystem of ['existing', 'shadcn-ui', 'material', 'custom', 'later']) {
    const root = await fixture(t);
    const result = await onboardProject({ projectRoot: root, answers: { designSystem, ...(designSystem === 'custom' ? { libraryName: 'My UI' } : {}) }, distribution: policy });
    assert.ok(!result.config.rules.includes(policy.defaults.rules[0]));
    assert.equal(result.config.componentStates, undefined);
    const before = await readFile(join(root, '.figma-design.json'), 'utf8');
    assert.equal((await onboardProject({ projectRoot: root, answers: { designSystem: 'distribution' }, distribution: policy })).status, 'existing');
    assert.equal(await readFile(join(root, '.figma-design.json'), 'utf8'), before);
  }
  const custom = configFromAnswers({ designSystem: 'distribution', theme: 'dark', primaryColor: '#123456', rules: ['My additional rule.'] }, 'App', policy);
  assert.equal(custom.foundation.theme, 'dark');
  assert.equal(custom.foundation.colors[0].value, '#123456');
  assert.equal(custom.rules.at(-1), 'My additional rule.');
});

test('minimal packages may omit defaults; malformed policies and file-specific IDs are rejected', async t => {
  const root = await fixture(t);
  assert.equal(await loadDistribution(root), null);
  assert.throws(() => configFromAnswers({ designSystem: 'distribution' }, 'App'), /no distribution/);
  await mkdir(join(root, 'assets'));
  const path = join(root, 'assets/distribution.json');
  await writeFile(path, '{');
  await assert.rejects(loadDistribution(root));
  await writeFile(path, JSON.stringify({ ...policy, defaults: { ...policy.defaults, library: { ...policy.defaults.library, components: { Button: '1:2' } } } }));
  await assert.rejects(loadDistribution(root), /component IDs/);
  await rm(path);
  await writeFile(join(root, 'policy.json'), JSON.stringify(policy));
  await symlink(join(root, 'policy.json'), path);
  await assert.rejects(loadDistribution(root), /regular JSON/);
});

test('standalone CLI resolves only its own package policy, never cwd or installation provenance', async t => {
  const root = await fixture(t);
  const publicRoot = join(root, 'public'), teamRoot = join(root, 'team'), project = join(root, 'project');
  await mkdir(project);
  for (const dir of [publicRoot, teamRoot]) {
    await mkdir(join(dir, 'scripts'), { recursive: true });
    await cp('skills/figma-local-design/scripts/onboarding.mjs', join(dir, 'scripts/onboarding.mjs'));
  }
  await mkdir(join(teamRoot, 'assets'));
  await writeFile(join(teamRoot, 'assets/distribution.json'), JSON.stringify(policy));
  await writeFile(join(publicRoot, '.skillstore-meta.json'), '{}');
  const run = (dir, ...args) => {
    const result = spawnSync(process.execPath, [join(dir, 'scripts/onboarding.mjs'), '--project', project, ...args], { cwd: teamRoot, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
  };
  assert.equal(run(publicRoot, '--non-interactive').welcome, undefined);
  assert.equal(run(teamRoot, '--non-interactive').welcome, policy.welcome);
  const answers = join(root, 'answers.json');
  await writeFile(answers, JSON.stringify({ designSystem: 'distribution' }));
  assert.equal(run(teamRoot, '--answers', answers).config.library.name, policy.defaults.library.name);
  // Saved rules remain usable even from a different package later.
  const validator = spawnSync(process.execPath, [resolve('skills/figma-local-design/scripts/project-rules.mjs'), '--project', project], { encoding: 'utf8' });
  assert.equal(validator.status, 0, validator.stderr);
  assert.deepEqual(JSON.parse(validator.stdout).config.rules, policy.defaults.rules);
});

test('all package channels keep identical design behavior without a private overlay', async t => {
  const root = await fixture(t);
  for (const name of ['scripts', 'skills', 'src']) await cp(name, join(root, name), { recursive: true });
  const built = spawnSync(process.execPath, [join(root, 'scripts/package-skillstore.mjs')], { encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
  const canonical = join(root, 'skills/figma-local-design');
  const target = join(root, 'dist/skillstore/figma-local-design');
  const publicPolicy = await loadDistribution(canonical);
  assert.equal(publicPolicy.defaults.library.name, 'Gravity UI');
  assert.deepEqual(await loadDistribution(target), publicPolicy);
  for (const name of ['SKILL.md', 'version.json', 'references/gravity-ui.md', 'assets/distribution.json', 'scripts/install.mjs']) {
    assert.equal(await readFile(join(target, name), 'utf8'), await readFile(join(canonical, name), 'utf8'));
  }
  const project = join(root, 'project'); await mkdir(project);
  const results = [canonical, target].map(dir => {
    const result = spawnSync(process.execPath, [join(dir, 'scripts/onboarding.mjs'), '--project', project, '--non-interactive'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
  });
  assert.deepEqual(results[0], results[1]);
  assert.equal(results[0].welcome, publicPolicy.welcome);
  const answers = join(root, 'answers.json');
  await writeFile(answers, JSON.stringify({ designSystem: 'distribution' }));
  const configs = [];
  for (const dir of [canonical, target]) {
    const selectedProject = await fixture(t);
    const result = spawnSync(process.execPath, [join(dir, 'scripts/onboarding.mjs'), '--project', selectedProject, '--answers', answers], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const config = JSON.parse(result.stdout).config;
    assert.equal(config.library.name, 'Gravity UI');
    // The project name intentionally differs; all actual design rules are equal.
    delete config.foundation.name;
    configs.push(config);
  }
  assert.deepEqual(configs[0], configs[1]);
});
