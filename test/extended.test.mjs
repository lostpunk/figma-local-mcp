import test from 'node:test';
import assert from 'node:assert/strict';
import { pluginHarness } from './plugin-harness.mjs';
const image = { dataBase64: Buffer.from([137, 80, 78, 71]).toString('base64'), scaleMode: 'FILL' };
const link = { action: 'NAVIGATE', trigger: 'ON_CLICK', transition: 'INSTANT', durationMs: 300, replaceExisting: false };
async function makeSet(h) {
  const source = h.node('COMPONENT', 'Button', h.page);
  const response = await h.call('create_component_set', { name: 'Button variants', x: 300, y: 10, spacing: 24,
    variants: ['Default', 'Hover'].map(State => ({ componentId: source.id, properties: { State } })) });
  assert.equal(response.error, undefined);
  return { source, set: h.nodes.get(response.result.id), variants: response.result.variants };
}

test('moving a master across pages keeps its ID, children and existing instance link', async () => {
  const h = pluginHarness();
  const main = h.node('COMPONENT', 'Button', h.page);
  const label = h.node('TEXT', 'Label', main);
  const instance = main.createInstance();
  const destination = h.node('PAGE', 'Components', h.root);
  const moved = await h.call('move_component', { nodeId: main.id, parentId: destination.id, x: 80, y: 120 });
  assert.equal(moved.error, undefined);
  assert.equal(moved.result.id, main.id);
  assert.equal(main.parent, destination);
  assert.equal(destination.loaded, true);
  assert.equal(main.children[0], label);
  assert.equal(instance.parent, h.page);
  assert.equal(await instance.getMainComponentAsync(), main);
  assert.equal(main.x, 80); assert.equal(main.y, 120);
});

test('moving components rejects cycles, nested variants, remote masters and invalid destinations before writes', async () => {
  const h = pluginHarness(); const { source, set, variants } = await makeSet(h);
  const inside = h.node('FRAME', 'Inside', source);
  const move = (nodeId, parentId, x = 0) => h.call('move_component', { nodeId, parentId, x, y: 0 });
  assert.match((await move(source.id, inside.id)).error, /descendant/);
  assert.match((await move(variants[0].id, h.page.id)).error, /whole component set/);
  assert.match((await move(h.page.id, h.page.id)).error, /COMPONENT/);
  assert.match((await move(source.id, h.root.id)).error, /document metadata/);
  assert.match((await move(source.id, h.page.id, NaN)).error, /finite/);
  source.remote = true;
  assert.match((await move(source.id, h.page.id)).error, /remote/);
  assert.equal(source.parent, h.page); assert.equal(set.children.length, 2);
  const target = h.node('PAGE', 'Library', h.root);
  assert.equal((await move(set.id, target.id)).error, undefined);
  assert.deepEqual(set.children.map(n => n.id), variants.map(n => n.id));
});

test('reading a component set skips the forbidden property-definition getter on its variants', async () => {
  const h = pluginHarness(); const { set, variants } = await makeSet(h);
  for (const v of variants) Object.defineProperty(h.nodes.get(v.id), 'componentPropertyDefinitions', {
    get() { throw new Error('Can only get definitions of a set or non-variant component'); },
  });
  const read = await h.call('get_node', { nodeId: set.id, depth: 3, maxNodes: 100 });
  assert.equal(read.error, undefined);
  assert.deepEqual(read.result.componentPropertyDefinitions.State.variantOptions, ['Default', 'Hover']);
  assert.equal(read.result.children.length, 2);
  assert.equal(read.result.children[0].variantProperties.State, 'Default');
  assert.equal('componentPropertyDefinitions' in read.result.children[0], false);
});

test('image imports preserve aspect ratio and replace fills without moving/resizing the target', async () => {
  const h = pluginHarness();
  const imported = await h.call('import_image', { ...image, name: 'Photo', width: 400, x: 25 });
  assert.equal(imported.error, undefined); assert.equal(imported.result.height, 200);
  const node = h.nodes.get(imported.result.id);
  assert.equal(node.fills[0].type, 'IMAGE'); assert.equal(node.x, 25);
  const replaced = await h.call('import_image', { ...image, nodeId: node.id, scaleMode: 'FIT' });
  assert.equal(replaced.result.replacedFill, true); assert.equal(node.width, 400); assert.equal(node.x, 25);
  assert.equal(node.fills[0].scaleMode, 'FIT');
  assert.match((await h.call('import_image', { ...image, nodeId: h.page.id })).error, /editable fills/);
});

test('asset failures leave no new scene nodes and do not change existing fills', async () => {
  const h = pluginHarness(); const frame = h.node('FRAME', 'Screen', h.page);
  h.figma.createImage = () => { throw new Error('Image type is unsupported'); };
  const count = h.nodes.size;
  assert.match((await h.call('import_image', { ...image, nodeId: frame.id })).error, /unsupported/);
  assert.deepEqual(frame.fills, []); assert.equal(h.nodes.size, count);
  const factory = h.figma.createNodeFromSvg;
  h.figma.createNodeFromSvg = () => { const node = factory(); node.rescale = () => { throw new Error('Cannot scale'); }; return node; };
  assert.match((await h.call('import_svg', { svg: '<svg/>', width: 24 })).error, /Cannot scale/);
  assert.equal(h.nodes.size, count);
});

test('image destination is captured before asynchronous decoding finishes', async () => {
  const h = pluginHarness(); const other = h.node('PAGE', 'Other', h.root);
  h.figma.createImage = () => ({ hash: 'test', async getSizeAsync() { h.figma.currentPage = other; return { width: 10, height: 10 }; } });
  const imported = await h.call('import_image', image);
  assert.equal(h.nodes.get(imported.result.id).parent, h.page);
});

test('SVG imports create editable child nodes and scale the container proportionally', async () => {
  const h = pluginHarness(); const result = await h.call('import_svg', { svg: '<svg/>', width: 24, name: 'Icon', x: 40 });
  assert.equal(result.error, undefined); assert.equal(result.result.width, 24);
  const node = h.nodes.get(result.result.id); assert.equal(node.children[0].type, 'VECTOR'); assert.equal(node.x, 40);
});

test('variant sets use copies and can drive actual instance variant properties', async () => {
  const h = pluginHarness(); const { source, set, variants } = await makeSet(h);
  assert.equal(source.parent, h.page); assert.equal(source.name, 'Button');
  assert.equal(set.children.length, 2); assert.ok(variants.every(v => v.id !== source.id));
  const created = await h.call('create_instance', { componentId: variants[0].id, props: {} });
  const changed = await h.call('set_instance_properties', { nodeId: created.result.id, properties: { State: 'Hover' } });
  assert.equal(changed.result.componentProperties.State.value, 'Hover');
  const bad = await h.call('set_instance_properties', { nodeId: created.result.id, properties: { State: 'Missing' } });
  assert.match(bad.error, /Unknown variant/);
  assert.equal(h.nodes.get(created.result.id).componentProperties.State.value, 'Hover');
});

test('failed variant combination cleans up clones without deleting source components', async () => {
  const h = pluginHarness(); const source = h.node('COMPONENT', 'Source', h.page); const count = h.nodes.size;
  h.figma.combineAsVariants = () => { throw new Error('Combination failed'); };
  const failed = await h.call('create_component_set', { name: 'Set', x: 0, y: 0, spacing: 24,
    variants: ['A', 'B'].map(State => ({ componentId: source.id, properties: { State } })) });
  assert.match(failed.error, /cleaned up/); assert.equal(h.nodes.size, count); assert.equal(source.removed, false);
});

test('prototype changes preserve other triggers and reject invalid destinations before writes', async () => {
  const h = pluginHarness(); const a = h.node('FRAME', 'A', h.page); const b = h.node('FRAME', 'B', h.page);
  const button = h.node('RECTANGLE', 'Button', a);
  const hover = { trigger: { type: 'ON_HOVER' }, actions: [{ type: 'BACK' }] };
  button.reactions = [hover];
  const result = await h.call('set_prototype_link', { ...link, nodeId: button.id, destinationId: b.id, transition: 'DISSOLVE', durationMs: 250 });
  assert.equal(result.error, undefined); assert.equal(button.reactions.length, 2);
  assert.equal(button.reactions[1].actions[0].transition.duration, 0.25);
  assert.equal(button.reactions[0], hover);
  assert.match((await h.call('set_prototype_link', { ...link, nodeId: button.id, destinationId: a.id })).error, /already has/);
  const c = h.node('FRAME', 'C', h.page);
  assert.equal((await h.call('set_prototype_link', { ...link, nodeId: button.id, destinationId: c.id, replaceExisting: true })).error, undefined);
  assert.equal(button.reactions.length, 2);
  const other = h.node('PAGE', 'Other', h.root); const target = h.node('FRAME', 'Other screen', other);
  assert.match((await h.call('set_prototype_link', { ...link, nodeId: button.id, destinationId: target.id, replaceExisting: true })).error, /same page/);
  assert.equal(button.reactions[1].actions[0].destinationId, c.id);
});

test('NAVIGATE to the containing screen fails before writing, including nested sources and frame itself', async () => {
  const h = pluginHarness(); const screen = h.node('FRAME', 'Screen', h.page);
  const nested = h.node('FRAME', 'Nested frame', screen);
  const button = h.node('RECTANGLE', 'Button', nested);
  const previous = [{ trigger: { type: 'ON_CLICK' }, actions: [{ type: 'BACK' }] }];
  for (const source of [button, screen]) {
    source.reactions = previous;
    let writes = 0;
    source.setReactionsAsync = async () => { writes++; };
    const result = await h.call('set_prototype_link', { ...link, nodeId: source.id, destinationId: screen.id, replaceExisting: true });
    assert.match(result.error, /different screen.*No reactions were changed/);
    assert.equal(writes, 0);
    assert.equal(source.reactions, previous);
  }
});

test('interactive variants are constrained to one component set; flow starts preserve other flows', async () => {
  const h = pluginHarness(); const { variants } = await makeSet(h);
  const valid = await h.call('set_prototype_link', { ...link, action: 'CHANGE_TO', nodeId: variants[0].id, destinationId: variants[1].id });
  assert.equal(valid.error, undefined); assert.equal(valid.result.reactions[0].actions[0].navigation, 'CHANGE_TO');
  const unrelated = h.node('COMPONENT', 'Unrelated', h.page);
  assert.match((await h.call('set_prototype_link', { ...link, action: 'CHANGE_TO', nodeId: unrelated.id, destinationId: variants[1].id })).error, /same component set/);
  const a = h.node('FRAME', 'A', h.page); const b = h.node('FRAME', 'B', h.page);
  await h.call('set_prototype_start', { frameId: a.id, name: 'Checkout' });
  await h.call('set_prototype_start', { frameId: b.id, name: 'Catalog' });
  await h.call('set_prototype_start', { frameId: a.id, name: 'Checkout updated' });
  assert.equal(h.page.flowStartingPoints.length, 2);
  assert.match((await h.call('set_prototype_start', { frameId: a.id, name: 'Catalog' })).error, /already uses/);
});
