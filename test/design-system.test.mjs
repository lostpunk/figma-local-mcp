import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { guideSchema } from '../src/design-schema.mjs';
import { pluginHarness } from './plugin-harness.mjs';

const guideArgs = () => z.object(guideSchema).parse({ name: 'Brand' });

test('style guide creates editable specimens, tokens and text styles without changing active page', async () => {
  const h = pluginHarness();
  const response = await h.call('create_style_guide', guideArgs());
  assert.equal(response.error, undefined);
  const guide = response.result;
  assert.equal(h.variables.size, 24);
  assert.equal(h.styles.size, 5);
  assert.equal(h.figma.currentPage, h.page);
  assert.equal(h.nodes.get(guide.pageId).name, 'Brand — Style guide');
  const swatch = [...h.nodes.values()].find(n => n.type === 'RECTANGLE' && n.name === 'brand/primary');
  assert.equal(swatch.fills[0].boundVariables.color.id, guide.colors.find(c => c.name === 'brand/primary').id);
  const title = [...h.nodes.values()].find(n => n.textStyleId === guide.textStyles[0].id);
  assert.ok(title);
  const gap = [...h.nodes.values()].find(n => n.name === 'spacing/4');
  assert.equal(gap.boundVariables.itemSpacing.id, guide.spacing[0].id);
  const radius = [...h.nodes.values()].find(n => n.name === 'radius/0');
  assert.equal(radius.boundVariables.topLeftRadius.id, guide.radii[0].id);
  const count = h.nodes.size;
  assert.match((await h.call('create_style_guide', guideArgs())).error, /already exists/);
  assert.equal(h.nodes.size, count);
});

test('font failure occurs before resources; later failure cleans up all new resources', async () => {
  const h = pluginHarness();
  h.figma.loadFontAsync = async () => { throw new Error('Font unavailable'); };
  assert.match((await h.call('create_style_guide', guideArgs())).error, /Font unavailable/);
  assert.equal(h.collections.size, 0);
  assert.equal(h.nodes.size, 2);
  h.figma.loadFontAsync = async () => {};
  h.figma.createRectangle = () => { throw new Error('Injected specimen failure'); };
  assert.match((await h.call('create_style_guide', guideArgs())).error, /resources cleaned up/);
  assert.equal(h.collections.size, 0);
  assert.equal(h.variables.size, 0);
  assert.equal(h.styles.size, 0);
  assert.equal(h.nodes.size, 2);
});

test('scene failure deletes new nodes but preserves existing parent and content', async () => {
  const h = pluginHarness();
  const frame = h.node('FRAME', 'Existing', h.page);
  const existing = h.node('RECTANGLE', 'Keep', frame);
  const response = await h.call('create_scene', { parentId: frame.id, nodes: [
    { ref: 'container', type: 'FRAME', props: { name: 'New' } },
    { ref: 'bad', parentRef: 'container', type: 'ELLIPSE', props: { characters: 'invalid' } },
  ] });
  assert.match(response.error, /nodes cleaned up/);
  assert.deepEqual(frame.children.map(n => n.id), [existing.id]);
  assert.equal(h.nodes.size, 4);
});

test('binding resolves IDs and types before modifying a node; numeric binding can be cleared', async () => {
  const h = pluginHarness();
  const guide = (await h.call('create_style_guide', guideArgs())).result;
  const node = h.node('RECTANGLE', 'Before', h.page);
  assert.match((await h.call('update_node', { nodeId: node.id,
    props: { name: 'After', fillVariableId: guide.spacing[0].id } })).error, /COLOR variable/);
  assert.equal(node.name, 'Before');
  assert.equal((await h.call('update_node', { nodeId: node.id,
    props: { variableBindings: { width: guide.spacing[0].id } } })).error, undefined);
  assert.equal(node.boundVariables.width.id, guide.spacing[0].id);
  await h.call('update_node', { nodeId: node.id, props: { variableBindings: { width: null } } });
  assert.equal(node.boundVariables.width, undefined);
});

test('variable updates reject wrong types and modes without changing values', async () => {
  const h = pluginHarness();
  const guide = (await h.call('create_style_guide', guideArgs())).result;
  const variableId = guide.colors[0].id;
  const previous = JSON.stringify(h.variables.get(variableId).valuesByMode);
  assert.match((await h.call('set_variable', { variableId, value: 3 })).error, /match the variable type/);
  assert.match((await h.call('set_variable', { variableId, value: '#000000', modeId: 'missing' })).error, /Mode/);
  assert.equal(JSON.stringify(h.variables.get(variableId).valuesByMode), previous);
});

test('component instances reject recursive placement', async () => {
  const h = pluginHarness();
  const component = h.node('COMPONENT', 'Button', h.page);
  const child = h.node('FRAME', 'Inner', component);
  const size = h.nodes.size;
  assert.match((await h.call('create_instance', { componentId: component.id, parentId: child.id, props: {} })).error, /own component/);
  assert.equal(h.nodes.size, size);
});
