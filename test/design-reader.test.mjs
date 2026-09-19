import test from 'node:test';
import assert from 'node:assert/strict';
import { pluginHarness } from './plugin-harness.mjs';

function styledText(h, characters, segments) {
  const text = h.figma.createText();
  text.characters = characters;
  text.getStyledTextSegments = (fields, start, end) => segments
    .filter(run => run.end > start && run.start < end)
    .map(run => {
      const a = Math.max(start, run.start), b = Math.min(end, run.end);
      return { start: a, end: b, characters: characters.slice(a, b),
        ...Object.fromEntries(fields.filter(key => key in run).map(key => [key, run[key]])) };
    });
  return text;
}
const alias = id => ({ type: 'VARIABLE_ALIAS', id });

test('styled text preserves mixed runs, link data and bindings without editing or loading fonts', async () => {
  const h = pluginHarness();
  const text = styledText(h, 'Hello мир👕', [
    { start: 0, end: 6, fontSize: 12, fontName: { family: 'Inter', style: 'Regular' } },
    { start: 6, end: 11, fontSize: 24, hyperlink: { type: 'URL', value: 'https://example.com' },
      boundVariables: { fontSize: alias('size') }, fills: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }] },
  ]);
  const response = await h.call('get_text_runs', { nodeId: text.id });
  assert.equal(response.error, undefined);
  assert.deepEqual(response.result.runs.map(r => [r.characters, r.fontSize]), [['Hello ', 12], ['мир👕', 24]]);
  assert.equal(response.result.runs[1].boundVariables.fontSize.id, 'size');
  assert.equal(response.result.runs[1].hyperlink.value, 'https://example.com');
  assert.equal(response.result.complete, true);
  assert.equal(response.result.nextStart, null);
  assert.equal(text.characters, 'Hello мир👕');
  assert.equal(h.fonts.length, 0);
  assert.equal(h.undoCount, 0);
});

test('UTF-16 character and run pagination reconstructs text beyond the old 10000 character cap', async () => {
  const h = pluginHarness();
  const characters = ('A👕Б').repeat(3000);
  const text = styledText(h, characters, [
    { start: 0, end: 4, fontSize: 12 }, { start: 4, end: characters.length, fontSize: 14 },
  ]);
  let start = 0, output = '', pages = 0;
  do {
    const { result, error } = await h.call('get_text_runs', { nodeId: text.id, start, maxCharacters: 999, maxRuns: 1 });
    assert.equal(error, undefined);
    output += result.runs.map(r => r.characters).join('');
    assert.ok(result.nextStart === null || result.nextStart > start);
    start = result.nextStart;
    assert.ok(++pages < 30);
  } while (start !== null);
  assert.equal(output, characters);
  assert.match((await h.call('get_text_runs', { nodeId: text.id, start: 2 })).error, /surrogate/);
  assert.match((await h.call('get_text_runs', { nodeId: text.id, start: characters.length + 1 })).error, /exceeds/);
});

test('empty text, invalid fields, invalid budgets and non-text nodes return honest outcomes', async () => {
  const h = pluginHarness();
  const empty = h.figma.createText();
  empty.getStyledTextSegments = () => { throw new Error('must not read an empty range'); };
  assert.equal((await h.call('get_text_runs', { nodeId: empty.id })).result.complete, true);
  assert.match((await h.call('get_text_runs', { nodeId: empty.id, fields: ['script'] })).error, /Unknown text field/);
  assert.match((await h.call('get_text_runs', { nodeId: empty.id, maxCharacters: 1 })).error, /maxCharacters/);
  assert.match((await h.call('get_text_runs', { nodeId: empty.id, maxResponseBytes: 1 })).error, /maxResponseBytes/);
  assert.match((await h.call('get_text_runs', { nodeId: h.figma.createFrame().id })).error, /TEXT/);
  assert.match((await h.call('get_bound_variables', { nodeId: h.page.id })).error, /scene/);
});

test('text byte limits report stalled cursors and a focused read can recover', async () => {
  const h = pluginHarness();
  const text = styledText(h, 'К'.repeat(10000), [{ start: 0, end: 10000, fontSize: 12 }]);
  const response = await h.call('get_text_runs', { nodeId: text.id, maxResponseBytes: 4096 });
  assert.equal(response.result.blocked, true);
  assert.equal(response.result.nextStart, 0);
  assert.ok(Buffer.byteLength(JSON.stringify(response)) <= 4096);
  const retry = await h.call('get_text_runs', { nodeId: text.id, maxResponseBytes: 4096, maxCharacters: 200 });
  assert.equal(retry.result.nextStart, 200);
  assert.equal(retry.result.runs[0].characters.length, 200);
  assert.equal(retry.result.blocked, undefined);
  const hugeStyle = styledText(h, 'A', [{ start: 0, end: 1, fontSize: 12, fills: [{ data: 'X'.repeat(9000) }] }]);
  assert.equal((await h.call('get_text_runs', { nodeId: hugeStyle.id, maxResponseBytes: 4096 })).result.blocked, true);
  assert.equal((await h.call('get_text_runs', { nodeId: hugeStyle.id, maxResponseBytes: 4096, fields: ['fontSize'] })).result.complete, true);
});

test('instance identity comes from async main component and definitions from its variant set', async () => {
  const h = pluginHarness();
  const component = h.figma.createComponent();
  component.name = 'Size=Small'; component.key = 'component-key'; component.remote = true;
  const set = h.figma.combineAsVariants([component], h.page);
  set.key = 'set-key';
  const instance = component.createInstance();
  Object.defineProperty(component, 'componentPropertyDefinitions', { get() { throw new Error('Read the set'); } });
  Object.defineProperty(instance, 'mainComponent', { get() { throw new Error('Dynamic pages forbid this getter'); } });
  const { result, error } = await h.call('get_component_details', { nodeId: instance.id });
  assert.equal(error, undefined);
  assert.equal(result.component.id, component.id);
  assert.equal(result.component.key, 'component-key');
  assert.equal(result.component.remote, true);
  assert.equal(result.componentSet.id, set.id);
  assert.equal(result.definitionOwnerId, set.id);
  assert.deepEqual(result.componentPropertyDefinitions.Size.variantOptions, ['Small']);
  assert.equal(result.complete, true);
  assert.equal((await h.call('get_component_details', { nodeId: component.id })).result.definitionOwnerId, set.id);
  assert.equal((await h.call('get_component_details', { nodeId: set.id })).result.component.key, 'set-key');
  assert.equal(h.undoCount, 0);
});

test('missing and inaccessible main components are distinct from unrelated layers', async () => {
  const h = pluginHarness();
  const instance = h.figma.createComponent().createInstance();
  instance.getMainComponentAsync = async () => null;
  assert.equal((await h.call('get_component_details', { nodeId: instance.id })).result.status, 'main_component_missing');
  instance.getMainComponentAsync = async () => { throw new Error('private library detail'); };
  const failure = await h.call('get_component_details', { nodeId: instance.id });
  assert.equal(failure.result.status, 'unavailable');
  assert.ok(!JSON.stringify(failure).includes('private library detail'));
  assert.equal((await h.call('get_component_details', { nodeId: h.figma.createFrame().id })).result.status, 'not_component');
});

test('oversized component properties are omitted explicitly while identity remains available', async () => {
  const h = pluginHarness();
  const instance = h.figma.createComponent().createInstance();
  instance.componentProperties = { Label: { type: 'TEXT', value: 'Я'.repeat(5000) } };
  const response = await h.call('get_component_details', { nodeId: instance.id, maxResponseBytes: 4096 });
  assert.equal(response.result.complete, false);
  assert.deepEqual(response.result.omittedProperties, ['componentProperties']);
  assert.ok(response.result.component.id);
  assert.ok(Buffer.byteLength(JSON.stringify(response)) < 4096);
});

test('variables resolve for the actual consumer and preserve alias/mode evidence', async () => {
  const h = pluginHarness();
  const node = h.figma.createRectangle();
  node.resolvedVariableModes = { theme: 'dark' };
  node.boundVariables = { width: alias('width') };
  node.fills = [{ type: 'SOLID', boundVariables: { color: alias('color') } }];
  let consumers = [];
  h.variables.set('width', { id: 'width', name: 'width', variableCollectionId: 'theme', resolvedType: 'FLOAT',
    valuesByMode: { dark: alias('baseWidth') }, codeSyntax: { WEB: 'var(--width)' },
    resolveForConsumer(consumer) { consumers.push(consumer); return { value: 24, resolvedType: 'FLOAT' }; } });
  h.variables.set('color', { id: 'color', name: 'color', remote: true, variableCollectionId: 'theme', resolvedType: 'COLOR',
    valuesByMode: { dark: { r: 0, g: 0, b: 0 } },
    resolveForConsumer(consumer) { consumers.push(consumer); return { value: { r: 0, g: 0, b: 0 }, resolvedType: 'COLOR' }; } });
  const page1 = (await h.call('get_bound_variables', { nodeId: node.id, limit: 1 })).result;
  const page2 = (await h.call('get_bound_variables', { nodeId: node.id, offset: page1.nextOffset, limit: 1 })).result;
  assert.equal(page1.variables[0].id, 'color');
  assert.equal(page1.variables[0].remote, true);
  assert.equal(page2.variables[0].modeId, 'dark');
  assert.equal(page2.variables[0].modeValue.id, 'baseWidth');
  assert.equal(page2.variables[0].resolved.value, 24);
  assert.equal(page2.variables[0].codeSyntax.WEB, 'var(--width)');
  assert.equal(page2.nextOffset, null);
  assert.deepEqual(consumers, [node, node]);
  assert.deepEqual(node.resolvedVariableModes, { theme: 'dark' });
});

test('explicit text-run IDs are deduplicated, errors stay per-variable and do not invent values', async () => {
  const h = pluginHarness();
  const node = h.figma.createText();
  h.variables.set('unresolved', { id: 'unresolved', name: 'Token', variableCollectionId: 'unknown', valuesByMode: {},
    resolveForConsumer() { throw new Error('broken alias'); } });
  const original = h.figma.variables.getVariableByIdAsync;
  h.figma.variables.getVariableByIdAsync = async id => {
    if (id === 'unavailable') throw new Error('secret library name');
    return original(id);
  };
  const { result } = await h.call('get_bound_variables', { nodeId: node.id,
    variableIds: ['missing', 'unresolved', 'unavailable', 'missing'] });
  assert.deepEqual(result.variables.map(v => v.status), ['not_found', 'unresolved', 'unavailable']);
  assert.equal(result.scope, 'requested_ids_for_consumer');
  assert.equal(result.variables[1].modeId, null);
  assert.equal(result.variables[1].resolved, undefined);
  assert.equal(result.complete, false);
  assert.equal(result.nextOffset, null);
  assert.ok(!JSON.stringify(result).includes('secret library name'));
});

test('bounded variable traversal, no descendant scan and byte-limited resolution are explicit', async () => {
  const h = pluginHarness();
  const node = h.figma.createFrame();
  const child = h.node('RECTANGLE', 'child', node);
  child.boundVariables = { width: alias('child-only') };
  assert.equal((await h.call('get_bound_variables', { nodeId: node.id })).result.total, 0);
  node.boundVariables = { fills: Array.from({ length: 1200 }, (_, i) => alias(`v${i}`)) };
  const scanned = (await h.call('get_bound_variables', { nodeId: node.id })).result;
  assert.equal(scanned.scanTruncated, true);
  assert.equal(scanned.total, 1000);
  assert.equal(scanned.complete, false);
  h.variables.set('huge', { id: 'huge', name: 'К'.repeat(10000), variableCollectionId: 'x', valuesByMode: {},
    resolveForConsumer() { return { value: 1, resolvedType: 'FLOAT' }; } });
  const response = await h.call('get_bound_variables', { nodeId: node.id, variableIds: ['huge'], maxResponseBytes: 4096 });
  assert.equal(response.result.blocked, true);
  assert.equal(response.result.nextOffset, 0);
  assert.ok(Buffer.byteLength(JSON.stringify(response)) < 4096);
  assert.match((await h.call('get_bound_variables', { nodeId: node.id, variableIds: [1] })).error, /variableIds/);
});
