import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, rm, symlink, cp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { resolveComponentMappings } from '../src/component-mappings.mjs';
import { loadProjectRules } from '../src/project-config.mjs';
import { onboardProject } from '../src/onboarding.mjs';

const mapping = (patch = {}) => ({ figma: { kind: 'componentSet', key: 'test-button-set' },
  code: { sourceFile: 'src/Button.tsx', importFrom: '@/Button', exportName: 'Button' },
  props: [
    { kind: 'property', name: 'variant', property: 'Appearance', type: 'VARIANT', values: [{ figma: 'Primary', code: 'primary' }] },
    { kind: 'property', name: 'disabled', property: 'Disabled#1:0', type: 'BOOLEAN' },
    { kind: 'property', name: 'children', property: 'Label#2:0', type: 'TEXT' },
    { kind: 'constant', name: 'size', value: 'm' },
  ], ...patch });
const detail = (patch = {}) => ({ nodeId: '1:1', nodeType: 'INSTANCE', status: 'available', complete: true,
  omittedProperties: [], component: { key: 'test-button-primary' }, componentSet: { key: 'test-button-set' },
  componentProperties: { 'Disabled#1:0': { type: 'BOOLEAN', value: false }, 'Label#2:0': { type: 'TEXT', value: 'Buy' } },
  variantProperties: { Appearance: 'Primary' }, ...patch });
async function fixture(t, entries = [mapping()]) {
  const root = await mkdtemp(join(tmpdir(), 'figma-mappings-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src'));
  // Must not be loaded or executed by the resolver, even when the filename is JavaScript.
  await writeFile(join(root, 'src/Button.tsx'), 'throw new Error("DO NOT EXECUTE");');
  await writeFile(join(root, '.figma-design.json'), JSON.stringify({ codeComponents: entries }));
  return root;
}
const first = async (root, input = detail()) => (await resolveComponentMappings(root, input)).results[0];

test('maps keys, variants, boolean false, text and constants without running project code', async t => {
  const root = await fixture(t);
  const result = await first(root);
  assert.equal(result.status, 'mapped');
  assert.deepEqual({ ...result.props }, { variant: 'primary', disabled: false, children: 'Buy', size: 'm' });
  assert.equal(result.requiresCodeVerification, true);
  assert.equal(result.code.exportKind, 'named');
  const before = await readFile(join(root, '.figma-design.json'), 'utf8');
  assert.equal((await onboardProject({ projectRoot: root, distribution: null })).status, 'existing');
  assert.equal(await readFile(join(root, '.figma-design.json'), 'utf8'), before);
});

test('specific component overrides set mapping; set nodes use set keys, never names', async t => {
  const root = await fixture(t, [mapping(), mapping({ figma: { kind: 'component', key: 'test-button-primary' }, props: [] })]);
  assert.equal((await first(root)).matched.kind, 'component');
  assert.equal((await first(root, detail({ nodeType: 'COMPONENT_SET', component: { key: 'test-button-set' }, componentSet: undefined }))).matched.kind, 'componentSet');
  assert.equal((await first(root, detail({ component: { key: 'other', name: 'Button' }, componentSet: undefined }))).status, 'unmapped');
});

test('unknown variants, missing exact property suffix and incorrect types stay unresolved', async t => {
  const root = await fixture(t);
  const result = await first(root, detail({ variantProperties: { Appearance: 'Danger' },
    componentProperties: { Disabled: { type: 'BOOLEAN', value: true }, 'Label#2:0': { type: 'BOOLEAN', value: true } } }));
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.unresolved.map(item => item.reason), ['unmapped_value', 'property_unavailable', 'type_mismatch']);
  assert.deepEqual({ ...result.props }, { size: 'm' });
});

test('incomplete reads and conflicting variant evidence cannot claim complete mapping', async t => {
  const root = await fixture(t);
  assert.equal((await first(root, detail({ complete: false, omittedProperties: ['componentPropertyDefinitions'] }))).status, 'partial');
  const result = await first(root, detail({ componentProperties: { Appearance: { type: 'VARIANT', value: 'Secondary' } } }));
  assert.equal(result.unresolved[0].reason, 'conflicting_values');
  for (const status of ['unavailable', 'main_component_missing'])
    assert.equal((await first(root, detail({ status, complete: false }))).status, 'details_unavailable');
});

test('definitions do not supply guessed instance values; swaps require explicit literal conversion', async t => {
  const root = await fixture(t, [mapping({ props: [
    { kind: 'property', name: 'icon', property: 'Icon#1:0', type: 'INSTANCE_SWAP', values: [{ figma: '2:1', code: 'cart' }] },
    { kind: 'property', name: 'disabled', property: 'Disabled#1:0', type: 'BOOLEAN', values: [{ figma: false, code: null }, { figma: true, code: 1 }] },
  ] })]);
  const input = detail({ componentProperties: { 'Icon#1:0': { type: 'INSTANCE_SWAP', value: '2:1' }, 'Disabled#1:0': { type: 'BOOLEAN', value: false } } });
  assert.deepEqual({ ...(await first(root, input)).props }, { icon: 'cart', disabled: null });
  const result = await first(root, detail({ nodeType: 'COMPONENT', componentProperties: undefined,
    componentPropertyDefinitions: { 'Disabled#1:0': { type: 'BOOLEAN', defaultValue: false } } }));
  assert.equal(result.status, 'partial'); assert.equal(Object.keys(result.props).length, 0);
});

test('source missing, directories and symlinks outside selected project are explicit failures', async t => {
  const root = await fixture(t);
  await rm(join(root, 'src/Button.tsx'));
  assert.equal((await first(root)).sourceStatus, 'missing');
  await mkdir(join(root, 'src/Button.tsx'));
  assert.equal((await first(root)).sourceStatus, 'not_file');
  await rm(join(root, 'src/Button.tsx'), { recursive: true });
  const outside = await fixture(t);
  await symlink(join(outside, 'src/Button.tsx'), join(root, 'src/Button.tsx'));
  assert.equal((await first(root)).sourceStatus, 'outside_project');
  assert.equal((await first(root)).status, 'source_unavailable');
});

test('duplicate mappings, props, value choices and unsafe paths/names are rejected', async t => {
  const root = await fixture(t);
  const cases = [
    [mapping(), mapping()],
    [mapping({ props: [{ kind: 'constant', name: 'size', value: 1 }, { kind: 'constant', name: 'size', value: 2 }] })],
    [mapping({ props: [{ kind: 'constant', name: '__proto__', value: 'polluted' }] })],
    [mapping({ props: [{ kind: 'property', name: 'x', property: 'Size', type: 'VARIANT' }] })],
    [mapping({ props: [{ kind: 'property', name: 'x', property: 'Size', type: 'BOOLEAN', values: [{ figma: 'false', code: false }] }] })],
    [mapping({ props: [{ kind: 'property', name: 'x', property: 'Size', type: 'VARIANT', values: [{ figma: 'a', code: 1 }, { figma: 'a', code: 2 }] }] })],
    ...['../outside', '/absolute', 'C:/outside', 'src\\Button.tsx', 'src/../secret'].map(sourceFile =>
      [mapping({ code: { ...mapping().code, sourceFile } })]),
    [mapping({ code: { ...mapping().code, importFrom: 'https://example.com/module.js' } })],
  ];
  for (const codeComponents of cases) {
    await writeFile(join(root, '.figma-design.json'), JSON.stringify({ codeComponents }));
    await assert.rejects(loadProjectRules(root));
  }
});

test('context preserves coverage and unavailable components; mismatched node identity rejected', async t => {
  const root = await fixture(t);
  const context = { rootId: '0:1', coverage: { complete: false, nextOffset: 2 }, nodes: [
    { id: '0:1', type: 'FRAME', details: { component: { status: 'not_applicable' } } },
    { id: '1:1', type: 'INSTANCE', details: { component: { status: 'available', data: detail() } } },
    { id: '1:2', type: 'INSTANCE', details: { component: { status: 'byte_limit' } } },
  ] };
  const result = await resolveComponentMappings(root, context);
  assert.deepEqual(result.inputCoverage, context.coverage);
  assert.equal(result.mappingComplete, false);
  assert.deepEqual(result.results.map(item => item.status), ['mapped', 'details_unavailable']);
  context.nodes[1].id = '1:8';
  await assert.rejects(resolveComponentMappings(root, context), /do not match/);
});

test('missing/empty project mappings do not create a global fallback', async t => {
  const root = await fixture(t, []);
  assert.equal((await resolveComponentMappings(root, detail())).configuration, 'no_mappings');
  await rm(join(root, '.figma-design.json'));
  const result = await resolveComponentMappings(root, detail());
  assert.equal(result.configuration, 'missing'); assert.equal(result.results[0].status, 'unmapped');
});

test('long literal properties and repeated mappings cannot amplify output without bounds', async t => {
  const root = await fixture(t);
  const long = await first(root, detail({ componentProperties: { 'Label#2:0': { type: 'TEXT', value: 'a'.repeat(2001) } } }));
  assert.equal(long.unresolved.find(item => item.prop === 'children').reason, 'value_too_large');
  const props = Array.from({ length: 20 }, (_, i) => ({ kind: 'constant', name: `p${i}`, value: 'x'.repeat(2000) }));
  await writeFile(join(root, '.figma-design.json'), JSON.stringify({ codeComponents: [mapping({ props })] }));
  const nodes = Array.from({ length: 200 }, (_, i) => {
    const id = String(i).padEnd(200, '\u0000'); // Worst-case JSON escaping in omitted IDs.
    return { id, type: 'INSTANCE', details: { component: { status: 'available', data: detail({ nodeId: id }) } } };
  });
  const result = await resolveComponentMappings(root, { rootId: '0:1', nodes, coverage: { complete: true } });
  assert.equal(result.reason, 'output_byte_limit'); assert.equal(result.mappingComplete, false);
  assert.ok(result.results.length > 0); assert.ok(result.omittedNodeIds.length > 0);
  assert.equal(result.results.length + result.omittedNodeIds.length, 200);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 4 * 1024 * 1024);
});

test('bundled CLI works without dependencies, rejects oversized/malformed input, changes no project files', async t => {
  const root = await fixture(t);
  const cli = join(root, 'component-mappings.mjs');
  await cp('skills/figma-local-design/scripts/component-mappings.mjs', cli);
  const before = await readFile(join(root, '.figma-design.json'), 'utf8');
  const run = input => spawnSync(process.execPath, [cli, '--project', root], { input, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  const good = run(JSON.stringify(detail({ componentProperties: { ...detail().componentProperties,
    'Label#2:0': { type: 'TEXT', value: '<script>doNotExecute()</script>' } } })));
  assert.equal(good.status, 0, good.stderr);
  assert.equal(JSON.parse(good.stdout).results[0].props.children, '<script>doNotExecute()</script>');
  assert.equal(await readFile(join(root, '.figma-design.json'), 'utf8'), before);
  assert.notEqual(run('{').status, 0);
  const large = run(' '.repeat(4 * 1024 * 1024 + 1));
  assert.notEqual(large.status, 0); assert.match(large.stderr, /exceeds 4 MiB/);
});
