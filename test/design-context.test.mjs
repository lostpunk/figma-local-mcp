import test from 'node:test';
import assert from 'node:assert/strict';
import { pluginHarness } from './plugin-harness.mjs';

const alias = id => ({ type: 'VARIABLE_ALIAS', id });
function text(h, parent, characters = 'Buy now') {
  const node = h.node('TEXT', 'Label', parent);
  node.characters = characters;
  node.getStyledTextSegments = (fields, start, end) => [{ start, end, characters: characters.slice(start, end),
    fontSize: 16, fills: node.runFills ?? [], boundVariables: node.runVariables ?? {} }];
  return node;
}
const read = async (h, node, args = {}) => {
  const response = await h.call('get_design_context', { nodeId: node.id, includePreview: false, ...args });
  assert.equal(response.error, undefined);
  return response.result;
};

test('context combines structure, appearance, styled text, component identity and asset references without edits', async () => {
  const h = pluginHarness(), root = h.figma.createFrame();
  root.layoutMode = 'HORIZONTAL'; root.minWidth = 200; root.layoutWrap = 'WRAP';
  const label = text(h, root), component = h.figma.createComponent();
  component.key = 'button-key';
  const instance = component.createInstance(); root.appendChild(instance);
  instance.reactions = [{ trigger: { type: 'ON_CLICK' }, actions: [{ type: 'BACK' }] }];
  const image = h.node('RECTANGLE', 'Photo', root);
  image.fills = [{ type: 'IMAGE', imageHash: 'photo', scaleMode: 'FILL' }];
  label.runFills = [{ type: 'IMAGE', imageHash: 'text-image', scaleMode: 'FILL' }];
  const initialNodes = h.nodes.size;
  const result = await read(h, root);
  assert.deepEqual(result.nodes.map(n => n.id), [root.id, label.id, instance.id, image.id]);
  assert.equal(result.nodes[0].properties.layoutWrap, 'WRAP');
  assert.equal(result.nodes[0].properties.minWidth, 200);
  assert.equal(result.nodes[1].details.text.data.runs[0].characters, 'Buy now');
  assert.equal(result.nodes[2].details.component.data.component.key, 'button-key');
  assert.equal(result.nodes[2].properties.reactions[0].trigger.type, 'ON_CLICK');
  assert.deepEqual(result.nodes[3].assets.imageHashes, ['photo']);
  assert.deepEqual(result.nodes[1].assets.imageHashes, ['text-image']);
  assert.equal(result.consistency, 'live_non_atomic');
  assert.equal(result.coverage.complete, true);
  assert.equal(h.nodes.size, initialNodes);
  assert.equal(h.undoCount, 0);
  assert.equal(h.fonts.length, 0);
  assert.deepEqual(h.page.selection, []);
});

test('variable definitions are read once per context, but values remain consumer-specific including text runs', async () => {
  const h = pluginHarness(), root = h.figma.createFrame(), a = text(h, root), b = text(h, root);
  a.boundVariables = { fontSize: [alias('token')] }; b.runVariables = { fontSize: alias('token') };
  let calls = 0;
  const local = h.figma.variables.getLocalVariablesAsync;
  h.figma.variables.getLocalVariablesAsync = async () => { calls++; return local(); };
  h.variables.set('token', { id: 'token', name: 'size', variableCollectionId: 'theme', valuesByMode: {},
    resolveForConsumer(node) { return { value: node === a ? 16 : 24, resolvedType: 'FLOAT' }; } });
  const first = await read(h, root);
  assert.equal(calls, 1);
  assert.equal(first.nodes[1].details.variables.data.variables[0].resolved.value, 16);
  assert.equal(first.nodes[2].details.textVariables.data.variables[0].resolved.value, 24);
  await read(h, root);
  assert.equal(calls, 2, 'cache does not outlive one context command');
  let remoteCalls = 0;
  h.figma.variables.getLocalVariablesAsync = async () => [];
  h.figma.variables.getVariableByIdAsync = async id => { remoteCalls++; return h.variables.get(id); };
  const remote = await read(h, root);
  assert.equal(remoteCalls, 1);
  assert.equal(remote.nodes[1].details.variables.data.variables[0].resolved.value, 16);
  assert.equal(remote.nodes[2].details.textVariables.data.variables[0].resolved.value, 24);
});

test('preorder pagination preserves node order, parents and depth without exporting extra previews', async () => {
  const h = pluginHarness(), root = h.figma.createFrame();
  const group = h.node('FRAME', 'Group', root), child = h.node('RECTANGLE', 'Inside', group);
  const sibling = h.node('RECTANGLE', 'Sibling', root);
  let exports = 0;
  root.exportAsync = async () => { exports++; return new Uint8Array([137, 80, 78, 71]); };
  const first = await read(h, root, { maxNodes: 2, includePreview: true });
  assert.equal(first.coverage.nextOffset, 2);
  assert.equal(first.coverage.reason, 'node_limit');
  const second = await read(h, root, { offset: 2, maxNodes: 2, includePreview: true });
  assert.deepEqual([...first.nodes, ...second.nodes].map(n => n.id), [root.id, group.id, child.id, sibling.id]);
  assert.equal(second.nodes[0].parentId, group.id);
  assert.equal(second.nodes[0].depth, 2);
  assert.equal(second.preview.status, 'not_requested_on_continuation');
  assert.equal(second.coverage.nextOffset, null);
  assert.equal(exports, 1);
});

test('depth limits identify narrower roots, and offsets past the current tree are not called complete', async () => {
  const h = pluginHarness(), root = h.figma.createFrame();
  h.node('RECTANGLE', 'Hidden below requested depth', root);
  const shallow = await read(h, root, { depth: 0 });
  assert.equal(shallow.nodes.length, 1);
  assert.equal(shallow.nodes[0].childrenOutsideDepth, true);
  assert.equal(shallow.coverage.reason, 'depth_limit');
  assert.equal(shallow.coverage.complete, false);
  const stale = await read(h, root, { offset: 5 });
  assert.equal(stale.coverage.reason, 'offset_past_end');
  assert.equal(stale.coverage.complete, false);
});

test('optional sections avoid expensive APIs and CSS failures do not hide other data', async () => {
  const h = pluginHarness(), node = text(h, h.page);
  node.getStyledTextSegments = () => { throw new Error('must not read text'); };
  node.getCSSAsync = async () => { throw new Error('private inspection data'); };
  node.exportAsync = async () => { throw new Error('must not render'); };
  const light = await read(h, node, { includeText: false, includeVariables: false, includeComponents: false });
  assert.equal(light.nodes[0].details.text.status, 'not_requested');
  assert.equal(light.nodes[0].details.css.status, 'not_requested');
  assert.equal(light.coverage.complete, true);
  const failed = await read(h, node, { includeText: false, includeVariables: false, includeCSS: true });
  assert.equal(failed.nodes[0].details.css.status, 'unavailable');
  assert.equal(failed.nodes[0].properties.fontSize, 12);
  assert.equal(failed.coverage.detailsComplete, false);
  assert.ok(!JSON.stringify(failed).includes('private inspection data'));
  node.getCSSAsync = async () => ({ display: 'flex', 'font-size': '16px' });
  const css = await read(h, node, { includeText: false, includeVariables: false, includeCSS: true });
  assert.equal(css.nodes[0].details.css.data.properties.display, 'flex');
});

test('long text retains continuation and a missing component remains an explicit gap', async () => {
  const h = pluginHarness(), root = h.figma.createFrame(), label = text(h, root, 'x'.repeat(12000));
  const instance = h.figma.createComponent().createInstance(); root.appendChild(instance);
  instance.getMainComponentAsync = async () => null;
  const result = await read(h, root);
  assert.equal(result.nodes[1].details.text.status, 'partial');
  assert.equal(result.nodes[1].details.text.data.nextStart, 2000);
  assert.equal(result.nodes[1].details.text.data.characterCount, label.characters.length);
  assert.equal(result.nodes[2].details.component.status, 'partial');
  assert.equal(result.nodes[2].details.component.data.status, 'main_component_missing');
  assert.equal(result.coverage.complete, false);
});

test('byte budgets handle multibyte names, oversized properties and previews without transport overflow', async () => {
  const h = pluginHarness(), root = h.figma.createFrame();
  root.name = '👕'.repeat(1000);
  for (let i = 0; i < 12; i++) {
    const node = h.node('RECTANGLE', 'Я'.repeat(400), root);
    node.fills = [{ type: 'IMAGE', imageHash: 'x'.repeat(20000), scaleMode: 'FILL' }];
  }
  root.exportAsync = async () => new Uint8Array(4000);
  for (const maxResponseBytes of [4096, 8192, 16384]) {
    const response = await h.call('get_design_context', { nodeId: root.id, maxResponseBytes });
    assert.equal(response.error, undefined);
    assert.ok(Buffer.byteLength(JSON.stringify(response)) <= maxResponseBytes);
    assert.equal(response.result.coverage.complete, false);
    assert.equal(response.result.preview.status, 'byte_limit');
    if (response.result.coverage.nextOffset !== null) assert.ok(response.result.coverage.nextOffset > 0);
  }
  const details = await read(h, root.children[0], { maxResponseBytes: 8192 });
  assert.ok(details.nodes[0].omittedProperties.includes('fills'));
  assert.equal(details.nodes[0].assets.complete, false);
});

test('property read failures are reported while independent properties and siblings remain readable', async () => {
  const h = pluginHarness(), root = h.figma.createFrame(), child = h.node('RECTANGLE', 'Child', root);
  Object.defineProperty(child, 'fills', { get() { throw new Error('private style name'); } });
  const result = await read(h, root);
  assert.ok(result.nodes[1].unavailableProperties.includes('fills'));
  assert.equal(result.nodes[1].properties.width, 100);
  assert.equal(result.nodes[1].assets.complete, false);
  assert.ok(!JSON.stringify(result).includes('private style name'));
});

test('preview is bounded to the root, reports actual scale, and failure leaves design data usable', async () => {
  const h = pluginHarness(), root = h.figma.createFrame();
  root.absoluteBoundingBox = { x: 0, y: 0, width: 3200, height: 1200 };
  const first = await read(h, root, { includePreview: true });
  assert.equal(first.preview.scale, 0.5);
  assert.equal(first.preview.status, 'available');
  assert.equal(root.lastExport.constraint.value, 0.5);
  root.exportAsync = async () => { throw new Error('render failed'); };
  const second = await read(h, root, { includePreview: true });
  assert.equal(second.preview.status, 'unavailable');
  assert.equal(second.nodes[0].id, root.id);
});

test('context rejects pages and invalid bounds before inspecting design sections', async () => {
  const h = pluginHarness(), root = h.figma.createFrame();
  for (const args of [{ depth: 7 }, { offset: 10000 }, { maxNodes: 201 }, { maxResponseBytes: 1 }, { includeCSS: 'yes' }])
    assert.match((await h.call('get_design_context', { nodeId: root.id, ...args })).error, /Invalid/);
  assert.match((await h.call('get_design_context', { nodeId: h.page.id })).error, /scene/);
});

test('traversal safety cap requires narrower roots instead of returning an invalid continuation', async () => {
  const h = pluginHarness(), root = h.figma.createFrame();
  // Lightweight nodes are sufficient to exercise traversal rather than the test factory's methods.
  root.children = Array.from({ length: 10001 }, (_, i) => ({ id: `c:${i}`, name: 'Item', type: 'RECTANGLE', parent: root }));
  const result = await read(h, root, { offset: 9999, includeVariables: false });
  assert.equal(result.nodes.length, 1);
  assert.equal(result.coverage.reason, 'traversal_limit');
  assert.equal(result.coverage.nextOffset, null);
  assert.equal(result.coverage.complete, false);
});
