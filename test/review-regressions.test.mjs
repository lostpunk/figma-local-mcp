import test from 'node:test';
import assert from 'node:assert/strict';
import { pluginHarness } from './plugin-harness.mjs';
import { installationCheckFailure } from '../src/installation-check.mjs';

for (const command of ['reorder_nodes', 'reparent_nodes']) {
  for (const [selected, index, expected] of [
    [['B', 'C'], 2, ['A', 'D', 'B', 'C']],
    [['C', 'D'], 0, ['C', 'D', 'A', 'B']],
    [['D', 'B'], 1, ['A', 'D', 'B', 'C']],
    [['D', 'C', 'B', 'A'], 0, ['D', 'C', 'B', 'A']],
  ]) test(`${command} moves ${selected} to ${index} in requested order`, async () => {
    const h = pluginHarness();
    const parent = h.node('FRAME', 'Container', h.page);
    const nodes = Object.fromEntries(['A', 'B', 'C', 'D'].map(name => [name, h.node('RECTANGLE', name, parent)]));
    const response = await h.call(command, { parentId: parent.id, nodeIds: selected.map(name => nodes[name].id), index, insertIndex: index });
    assert.equal(response.error, undefined);
    assert.deepEqual(parent.children.map(node => node.name), expected);
    assert.ok(Object.values(nodes).every(node => !node.removed));
  });
}

test('reparent combines existing children with external nodes without disturbing unselected order', async () => {
  const h = pluginHarness();
  const parent = h.node('FRAME', 'Container', h.page);
  const a = h.node('RECTANGLE', 'A', parent), b = h.node('RECTANGLE', 'B', parent), c = h.node('RECTANGLE', 'C', parent);
  const d = h.node('RECTANGLE', 'D', h.page);
  const result = await h.call('reparent_nodes', { parentId: parent.id, nodeIds: [b.id, d.id], insertIndex: 2 });
  assert.equal(result.error, undefined);
  assert.deepEqual(parent.children.map(node => node.id), [a.id, c.id, b.id, d.id]);
});

for (const matrix of [[[0, -1, 100], [1, 0, 100]], [[-1, 0, 100], [0, 1, 100]]]) {
  test(`reparent preserves complete world transform under ${JSON.stringify(matrix)}`, async () => {
    const h = pluginHarness();
    const parent = h.node('FRAME', 'Transformed', h.page);
    parent.relativeTransform = matrix;
    const child = h.node('RECTANGLE', 'Child', h.page);
    child.relativeTransform = [[0, -1, 120], [1, 0, 140]];
    const expected = child.absoluteTransform;
    const result = await h.call('reparent_nodes', { parentId: parent.id, nodeIds: [child.id] });
    assert.equal(result.error, undefined);
    assert.equal(child.parent, parent);
    assert.deepEqual(child.absoluteTransform, expected);
    assert.equal(result.result.preservedAbsolutePosition, true);
  });
}

test('reparent rejects singular destination and nested selections before editing', async () => {
  const h = pluginHarness();
  const parent = h.node('FRAME', 'Destination', h.page);
  parent.relativeTransform = [[0, 0, 10], [0, 0, 20]];
  const child = h.node('FRAME', 'Child', h.page);
  const grandchild = h.node('RECTANGLE', 'Grandchild', child);
  assert.match((await h.call('reparent_nodes', { parentId: parent.id, nodeIds: [child.id] })).error, /not invertible/);
  assert.match((await h.call('reparent_nodes', { parentId: parent.id, nodeIds: [child.id, grandchild.id] })).error, /ancestor/);
  assert.equal(child.parent, h.page);
  assert.equal(grandchild.parent, child);
  assert.equal(h.undoCount, 0);
});

test('read byte budget handles Unicode, supports continuation and property selection', async () => {
  const h = pluginHarness();
  const parent = h.node('FRAME', 'Large', h.page);
  for (let i = 0; i < 900; i++) {
    const node = h.node('TEXT', String(i), parent);
    node.characters = 'я🙂'.repeat(3333);
  }
  const result = await h.call('get_node', { nodeId: parent.id, depth: 1, maxNodes: 1000 });
  assert.equal(result.error, undefined);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 1024 * 1024);
  assert.equal(result.result.childrenTruncated, true);
  assert.ok(result.result.nextChildOffset > 0);
  const next = await h.call('get_node', { nodeId: parent.id, depth: 1, maxNodes: 1000,
    childOffset: result.result.nextChildOffset, fields: [] });
  assert.equal(next.error, undefined);
  assert.equal(next.result.children[0].id, parent.children[result.result.nextChildOffset].id);
  assert.equal(next.result.children[0].characters, undefined);
  const ids = new Set([...result.result.children, ...next.result.children].map(node => node.id));
  assert.equal(ids.size, 900);
  const text = await h.call('get_node', { nodeId: parent.children[899].id, depth: 0, fields: ['characters'] });
  assert.equal(text.result.characters, parent.children[899].characters);
});

test('large properties are explicitly omitted and selection pagination shares one byte budget', async () => {
  const h = pluginHarness();
  const nodes = Array.from({ length: 20 }, (_, i) => h.node('RECTANGLE', String(i), h.page));
  nodes[0].reactions = [{ payload: '🙂'.repeat(100000) }];
  h.page.selection = nodes;
  const result = await h.call('get_selection', { depth: 0, maxNodes: 1000, maxResponseBytes: 8192 });
  assert.equal(result.error, undefined);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 8192);
  assert.ok(result.result.nodes[0].omittedProperties.includes('reactions'));
  assert.equal(result.result.selectionTruncated, true);
  const next = await h.call('get_selection', { depth: 0, selectionOffset: result.result.nextSelectionOffset, fields: [] });
  assert.equal(next.result.nodes[0].id, nodes[result.result.nextSelectionOffset].id);
  assert.equal(new Set([...result.result.nodes, ...next.result.nodes].map(n => n.id)).size, nodes.length);
});

test('installation failures expose safe actionable categories without child output', () => {
  const secret = 'private-design /Users/person/private token=not-for-output';
  const cases = [
    [{ error: { code: 'ETIMEDOUT' }, stderr: secret }, 'CHECK_TIMEOUT'],
    [{ status: 1, stdout: JSON.stringify({ error: { code: 'EPERM', stage: 'bridge' } }), stderr: secret }, 'LOCAL_SOCKET_DENIED'],
    [{ status: 1, stderr: 'listen EACCES ' + secret }, 'LOCAL_SOCKET_DENIED'],
    [{ status: 1, stdout: JSON.stringify({ error: { code: 'EACCES', stage: 'asset-access' } }), stderr: secret }, 'ASSET_ACCESS_CHECK_FAILED'],
    [{ status: 1, stderr: 'ERR_MODULE_NOT_FOUND ' + secret }, 'INVALID_RUNTIME'],
    [{ status: 1, stderr: 'SyntaxError ' + secret }, 'INVALID_RUNTIME'],
    [{ status: 1, stderr: secret }, 'RUNTIME_CHECK_FAILED'],
  ];
  for (const [result, code] of cases) {
    const error = installationCheckFailure(result);
    assert.equal(error.code, code);
    assert.match(error.message, /installation check failed/);
    assert.ok(!error.message.includes(secret));
  }
});

test('reorder only reinserts selected nodes and never detaches or reinserts unrelated layers', async () => {
  const h = pluginHarness();
  const parent = h.node('FRAME', 'Container', h.page);
  const nodes = ['A', 'B', 'C', 'D'].map(name => h.node('RECTANGLE', name, parent));
  const selected = new Set([nodes[1].id, nodes[2].id]);
  for (const method of ['appendChild', 'insertChild']) {
    const original = parent[method];
    parent[method] = (...args) => {
      assert.ok(selected.has(args.at(-1).id), 'only selected layers should be reinserted');
      return original(...args);
    };
  }
  const result = await h.call('reorder_nodes', { parentId: parent.id, nodeIds: [...selected], index: 2 });
  assert.equal(result.error, undefined);
  assert.deepEqual(parent.children.map(n => n.name), ['A', 'D', 'B', 'C']);
});

test('response guard preserves the supported 8 MiB PNG export', async () => {
  const h = pluginHarness();
  const node = h.node('RECTANGLE', 'Export', h.page);
  node.exportAsync = async () => new Uint8Array(8 * 1024 * 1024);
  const result = await h.call('export_node', { nodeId: node.id, format: 'PNG', scale: 1 });
  assert.equal(result.error, undefined);
  assert.equal(Buffer.from(result.result.data, 'base64').length, 8 * 1024 * 1024);
});

test('the minimum read budget still advances through direct children', async () => {
  const h = pluginHarness();
  const frame = h.node('FRAME', 'Frame', h.page);
  for (let i = 0; i < 10; i++) h.node('RECTANGLE', String(i), frame);
  const seen = [];
  let childOffset = 0;
  do {
    const response = await h.call('get_node', { nodeId: frame.id, depth: 1, maxNodes: 100,
      maxResponseBytes: 4096, fields: [], childOffset });
    assert.equal(response.error, undefined);
    assert.ok(Buffer.byteLength(JSON.stringify(response)) <= 4096);
    assert.ok(response.result.children.length > 0);
    seen.push(...response.result.children.map(node => node.id));
    childOffset = response.result.nextChildOffset;
  } while (childOffset !== null);
  assert.deepEqual(seen, frame.children.map(node => node.id));
});
