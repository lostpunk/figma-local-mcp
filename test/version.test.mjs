import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { VERSION } from '../src/readiness.mjs';
import { pluginHarness } from './plugin-harness.mjs';

const readJson = async path => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
const { version } = await readJson('../package.json');

test('source server advertises the package release version', () => {
  assert.equal(VERSION, version);
});

test('compiled plugin advertises the package release version on initialization', async () => {
  assert.equal((await pluginHarness().getDocument()).pluginVersion, version);
});

test('all release metadata agrees with the package version', async () => {
  for (const path of ['../.codex-plugin/plugin.json', '../skills/figma-local-design/version.json', '../skills/figma-local-design/package.json']) {
    assert.equal((await readJson(path)).version, version, path);
  }
  const lock = await readJson('../package-lock.json');
  assert.equal(lock.version, version);
  assert.equal(lock.packages[''].version, version);
});
