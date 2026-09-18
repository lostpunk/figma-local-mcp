import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, access, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { onboardProject, configFromAnswers, collectAnswers } from '../src/onboarding.mjs';
const fixture = async t => {
  const root = await mkdtemp(join(tmpdir(), 'figma-onboarding-'));
  t.after(() => rm(root, { recursive: true, force: true })); return root;
};

test('non-interactive first run asks for a project/choices without selecting or writing defaults', async t => {
  const root = await fixture(t);
  assert.equal((await onboardProject()).status, 'needs_project');
  const result = await onboardProject({ projectRoot: root });
  assert.equal(result.status, 'needs_input');
  assert.ok(result.questions[0].options.some(o => o.value === 'existing'));
  await assert.rejects(access(join(root, '.figma-design.json')), { code: 'ENOENT' });
});

test('different projects keep independent choices and reinstall never overwrites them', async t => {
  const a = await fixture(t), b = await fixture(t);
  const chosen = { designSystem: 'shadcn-ui', name: 'App', theme: 'dark', density: 'compact', platform: 'both', fontFamily: 'Inter', primaryColor: '#123456' };
  assert.equal((await onboardProject({ projectRoot: a, answers: chosen })).status, 'configured');
  await onboardProject({ projectRoot: b, answers: { designSystem: 'custom', libraryName: 'Our kit', theme: 'light' } });
  const before = await readFile(join(a, '.figma-design.json'), 'utf8');
  assert.equal(JSON.parse(before).foundation.colors[0].value, '#123456');
  const repeat = await onboardProject({ projectRoot: a, answers: { designSystem: 'material' }, interactive: true,
    ask: () => { throw new Error('Must not ask again'); } });
  assert.equal(repeat.status, 'existing');
  assert.equal(await readFile(join(a, '.figma-design.json'), 'utf8'), before);
  assert.equal(JSON.parse(await readFile(join(b, '.figma-design.json'), 'utf8')).library.name, 'Our kit');
});

test('preserve-existing and defer choices do not insert starter tokens or automatic font defaults', async t => {
  const existing = configFromAnswers({ designSystem: 'existing' }, 'App');
  assert.equal(existing.foundation.colors, undefined);
  assert.equal(existing.foundation.fontFamily, undefined);
  assert.equal(existing.library, undefined);
  const root = await fixture(t);
  const deferred = await onboardProject({ projectRoot: root, answers: { designSystem: 'later' } });
  assert.equal(deferred.status, 'deferred');
  assert.equal(deferred.config.foundation, undefined);
  assert.equal((await onboardProject({ projectRoot: root })).status, 'existing');
});

test('bad answers and existing broken rules fail without overwrite or repeated prompts', async t => {
  const root = await fixture(t);
  await assert.rejects(onboardProject({ projectRoot: root, answers: { designSystem: 'custom' } }), /Name your design system/);
  await assert.rejects(access(join(root, '.figma-design.json')), { code: 'ENOENT' });
  const bad = JSON.stringify({ rulesFiles: ['missing.md'] });
  await writeFile(join(root, '.figma-design.json'), bad);
  await assert.rejects(onboardProject({ projectRoot: root, interactive: true, ask: () => { throw new Error('Unexpected question'); } }), /ENOENT/);
  assert.equal(await readFile(join(root, '.figma-design.json'), 'utf8'), bad);
});

test('simultaneous first runs create one configuration and preserve the winner', async t => {
  const root = await fixture(t);
  const results = await Promise.all(['shadcn-ui', 'material'].map(designSystem => onboardProject({ projectRoot: root, answers: { designSystem } })));
  assert.deepEqual(results.map(r => r.status).sort(), ['configured', 'existing']);
  const result = results.find(r => r.status === 'configured');
  assert.deepEqual(JSON.parse(await readFile(join(root, '.figma-design.json'), 'utf8')), result.config);
});

test('interactive choices require an explicit design system, allow skipping and validate colors', async t => {
  const responses = ['', 'invalid', '2', 'My app', '2', '3', '4', 'Inter', 'red', '#123456', 'Use Russian'];
  const answers = await collectAnswers(async () => responses.shift(), 'Project');
  assert.equal(answers.designSystem, 'shadcn-ui');
  assert.equal(answers.theme, 'light');
  assert.equal(answers.density, 'compact');
  assert.equal(answers.platform, 'both');
  assert.equal(answers.primaryColor, '#123456');
  assert.deepEqual(await collectAnswers(async () => '5', 'Project'), { designSystem: 'later' });
  assert.equal((await onboardProject({ interactive: true, ask: async () => '' })).status, 'deferred');
  const root = await fixture(t);
  await assert.rejects(onboardProject({ projectRoot: root, interactive: true, ask: async () => { throw new Error('Aborted'); } }), /Aborted/);
  await assert.rejects(access(join(root, '.figma-design.json')), { code: 'ENOENT' });
});

test('standalone onboarding CLI works without dependencies and without invoking validator CLI twice', async t => {
  const root = await fixture(t);
  const script = join(root, 'onboarding.mjs');
  await cp('skills/figma-local-design/scripts/onboarding.mjs', script);
  const run = (...args) => spawnSync(process.execPath, [script, '--project', root, ...args], { encoding: 'utf8' });
  const pending = run('--non-interactive');
  assert.equal(pending.status, 0, pending.stderr);
  assert.equal(JSON.parse(pending.stdout).status, 'needs_input');
  const answers = join(root, 'answers.json');
  await writeFile(answers, JSON.stringify({ designSystem: 'material', theme: 'light', platform: 'mobile' }));
  const done = run('--answers', answers);
  assert.equal(done.status, 0, done.stderr);
  assert.equal(JSON.parse(done.stdout).config.library.name, 'Material Design');
});
