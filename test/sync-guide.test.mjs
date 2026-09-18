import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { guideSchema, syncGuideSchema } from '../src/design-schema.mjs';
import { pluginHarness } from './plugin-harness.mjs';
const setup = async () => {
  const h = pluginHarness();
  const guide = (await h.call('create_style_guide', z.object(guideSchema).parse({ name: 'Brand' }))).result;
  return { h, guide };
};

test('sync schema is a patch with preview default and no implicit typography defaults', () => {
  assert.deepEqual(z.object(syncGuideSchema).parse({ collectionId: 'a' }), { collectionId: 'a', dryRun: true });
  assert.equal(z.object(syncGuideSchema).safeParse({ collectionId: 'a', typography: [{ name: 'Body', fontSize: 16 }] }).success, false);
});

test('preview shows before/after without writes; apply preserves IDs, other modes and omitted resources', async () => {
  const { h, guide } = await setup();
  const variable = h.variables.get(guide.colors[0].id);
  variable.valuesByMode.dark = { r: 0, g: 0, b: 0 };
  const style = h.styles.get(guide.textStyles[0].id);
  const originalColor = structuredClone(variable.valuesByMode['mode:1']);
  const originalLineHeight = structuredClone(style.lineHeight);
  const args = { collectionId: guide.collectionId, colors: [{ name: guide.colors[0].name, value: '#123456' }, { name: 'new', value: '#abcdef' }],
    typography: [{ name: 'Heading/H1', fontFamily: 'Inter', fontStyle: 'Bold', fontSize: 44 }] };
  const counts = { nodes: h.nodes.size, variables: h.variables.size, styles: h.styles.size, undo: h.undoCount };
  const preview = (await h.call('sync_style_guide', args)).result;
  assert.equal(preview.dryRun, true);
  assert.deepEqual(JSON.parse(JSON.stringify(preview.changes[0].before)), originalColor);
  assert.equal(preview.changes[0].after.r, 0x12 / 255);
  assert.deepEqual(JSON.parse(JSON.stringify(variable.valuesByMode['mode:1'])), originalColor);
  assert.equal(h.undoCount, counts.undo);
  assert.equal(h.variables.size, counts.variables);
  const applied = await h.call('sync_style_guide', { ...args, dryRun: false });
  assert.equal(applied.error, undefined);
  assert.equal(applied.result.changes[0].id, variable.id);
  assert.equal(applied.result.changes[2].id, style.id);
  assert.equal(variable.valuesByMode['mode:1'].r, 0x12 / 255);
  assert.deepEqual(variable.valuesByMode.dark, { r: 0, g: 0, b: 0 });
  assert.deepEqual(JSON.parse(JSON.stringify(style.lineHeight)), originalLineHeight);
  assert.equal(style.fontSize, 44);
  assert.equal(h.nodes.size, counts.nodes);
  assert.equal(h.variables.size, counts.variables + 1);
  assert.equal(h.styles.size, counts.styles);
  const undoAfterApply = h.undoCount;
  // Figma normalizes variable colors to RGBA; that must still be a no-op on repeat.
  variable.valuesByMode['mode:1'].a = 1;
  const repeat = (await h.call('sync_style_guide', { ...args, dryRun: false })).result;
  assert.ok(repeat.changes.every(c => c.action === 'unchanged'));
  assert.equal(h.undoCount, undoAfterApply);
  assert.equal(h.variables.size, counts.variables + 1);
});

test('ambiguity, type conflicts and missing fonts fail before changing resources', async () => {
  const { h, guide } = await setup();
  const variable = h.variables.get(guide.colors[0].id);
  const duplicate = h.figma.variables.createVariable(variable.name, h.collections.get(guide.collectionId), 'COLOR');
  const args = { collectionId: guide.collectionId, dryRun: false, colors: [{ name: guide.colors[0].name, value: '#000000' }] };
  const previous = JSON.stringify(variable.valuesByMode);
  assert.match((await h.call('sync_style_guide', args)).error, /Ambiguous variable name/);
  duplicate.remove(); variable.resolvedType = 'FLOAT';
  assert.match((await h.call('sync_style_guide', args)).error, /conflict/);
  variable.resolvedType = 'COLOR';
  h.figma.loadFontAsync = async () => { throw new Error('Missing font'); };
  assert.match((await h.call('sync_style_guide', { ...args, typography: [{ name: 'Heading/H1', fontFamily: 'Missing', fontStyle: 'Regular', fontSize: 44 }] })).error, /Missing font/);
  assert.equal(JSON.stringify(variable.valuesByMode), previous);
});

test('late style failure rolls back existing values and removes only newly created resources', async () => {
  const { h, guide } = await setup();
  const variable = h.variables.get(guide.colors[0].id);
  const previous = JSON.stringify(variable.valuesByMode);
  const style = h.styles.get(guide.textStyles[0].id);
  const originalStyle = { fontSize: style.fontSize, fontName: style.fontName, lineHeight: style.lineHeight };
  const counts = [h.variables.size, h.styles.size, h.nodes.size];
  let size = style.fontSize;
  Object.defineProperty(style, 'fontSize', { get: () => size, set: value => { if (value === 99) throw new Error('Setter failure'); size = value; } });
  const response = await h.call('sync_style_guide', { collectionId: guide.collectionId, dryRun: false,
    colors: [{ name: guide.colors[0].name, value: '#000000' }, { name: 'new', value: '#ffffff' }],
    typography: [{ name: 'Heading/H1', fontFamily: 'Inter', fontStyle: 'Regular', fontSize: 99 }] });
  assert.match(response.error, /rolled back/);
  assert.equal(JSON.stringify(variable.valuesByMode), previous);
  assert.equal(style.fontSize, originalStyle.fontSize);
  assert.deepEqual(style.fontName, originalStyle.fontName);
  assert.deepEqual([h.variables.size, h.styles.size, h.nodes.size], counts);
});

test('sync never detaches typography variables or guesses between identical collection namespaces', async () => {
  const { h, guide } = await setup();
  const style = h.styles.get(guide.textStyles[0].id);
  style.boundVariables = { fontSize: { type: 'VARIABLE_ALIAS', id: 'font-size' } };
  const args = { collectionId: guide.collectionId, dryRun: false,
    typography: [{ name: 'Heading/H1', fontFamily: 'Inter', fontStyle: 'Bold', fontSize: 48 }] };
  assert.match((await h.call('sync_style_guide', args)).error, /will not detach/);
  assert.equal(style.fontSize, 40);
  h.figma.variables.createVariableCollection('Brand');
  assert.match((await h.call('sync_style_guide', args)).error, /namespace is ambiguous/);
});
