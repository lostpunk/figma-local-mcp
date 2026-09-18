import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { previewChangesSchema, applyChangesSchema } from '../src/change-schema.mjs';
import { pluginHarness } from './plugin-harness.mjs';

async function preview(h, changes) {
  const response = await h.call('preview_changes', { changes });
  assert.equal(response.error, undefined);
  return response.result;
}
const entry = (node, props) => ({ nodeId: node.id, props });
const apply = (h, plan, ids = plan.changes.map(c => c.id)) => h.call('apply_changes', { planId: plan.planId, changeIds: ids });

test('preview is a property diff without mutations; selected changes apply once', async () => {
  const h = pluginHarness();
  const node = h.node('RECTANGLE', 'Original', h.page);
  const count = h.nodes.size;
  const plan = await preview(h, [entry(node, { name: 'Renamed', width: 240, opacity: 0.5, height: 100 })]);
  assert.equal(plan.previewType, 'properties');
  assert.deepEqual(plan.changes.map(c => [c.property, c.before, c.after]), [['name', 'Original', 'Renamed'], ['width', 100, 240], ['opacity', 1, 0.5]]);
  assert.equal(node.name, 'Original'); assert.equal(node.width, 100);
  assert.equal(h.nodes.size, count); assert.equal(h.undoCount, 0);
  const result = await apply(h, plan, [plan.changes[1].id]);
  assert.equal(result.error, undefined);
  assert.deepEqual(result.result.appliedChangeIds, [plan.changes[1].id]);
  assert.equal(node.width, 240); assert.equal(node.name, 'Original'); assert.equal(node.opacity, 1);
  assert.equal(h.undoCount, 2);
  assert.match((await apply(h, plan)).error, /consumed/);
});

test('paint preview exposes replaced paints; null clears them, no-op plans cannot apply', async () => {
  const h = pluginHarness(); const node = h.node('RECTANGLE', 'Shape', h.page);
  node.fills = [{ type: 'GRADIENT_LINEAR', gradientStops: [] }];
  const plan = await preview(h, [entry(node, { fill: '#123456', stroke: '#abcdef', cornerRadius: 8 })]);
  assert.equal(plan.changes[0].before[0].type, 'GRADIENT_LINEAR');
  assert.equal((await apply(h, plan)).error, undefined);
  assert.equal(node.fills[0].color.r, 0x12 / 255);
  assert.equal((await preview(h, [entry(node, { fill: '#123456', cornerRadius: 8 })])).changes.length, 0);
  const clear = await preview(h, [entry(node, { fill: null })]);
  assert.equal((await apply(h, clear)).error, undefined); assert.equal(node.fills.length, 0);
  const noop = await preview(h, [entry(node, { name: node.name })]);
  assert.match((await apply(h, noop)).error, /Select/);
});

test('manual edits, ancestor resize, reparenting and deletion stop the entire batch before mutation', async () => {
  for (const kind of ['node', 'ancestor', 'reparent', 'delete']) {
    const h = pluginHarness(); const frame = h.node('FRAME', 'Frame', h.page);
    const first = h.node('RECTANGLE', 'First', frame); const second = h.node('ELLIPSE', 'Second', frame);
    const plan = await preview(h, [entry(first, { name: 'Changed' }), entry(second, { width: 200 })]);
    if (kind === 'node') second.opacity = 0.4;
    if (kind === 'ancestor') frame.width = 900;
    if (kind === 'reparent') h.page.appendChild(second);
    if (kind === 'delete') second.remove();
    assert.match((await apply(h, plan)).error, /changed|not found/i, kind);
    assert.equal(first.name, 'First'); assert.equal(second.width, 100); assert.equal(h.undoCount, 0);
  }
});

test('final preflight detects edits made during asynchronous node lookup', async () => {
  const h = pluginHarness(); const a = h.node('RECTANGLE', 'A', h.page); const b = h.node('RECTANGLE', 'B', h.page);
  const plan = await preview(h, [entry(a, { width: 200 }), entry(b, { width: 300 })]);
  const original = h.figma.getNodeByIdAsync;
  h.figma.getNodeByIdAsync = async id => {
    const result = await original(id);
    if (id === b.id) a.name = 'User edit';
    return result;
  };
  assert.match((await apply(h, plan)).error, /changed/);
  assert.equal(a.width, 100); assert.equal(b.width, 100); assert.equal(a.name, 'User edit');
});

test('unselected targets may change, but selection must contain unique known IDs', async () => {
  const h = pluginHarness(); const a = h.node('RECTANGLE', 'A', h.page); const b = h.node('RECTANGLE', 'B', h.page);
  const plan = await preview(h, [entry(a, { width: 200 }), entry(b, { width: 300 })]);
  assert.match((await apply(h, plan, ['bogus'])).error, /Unknown change/);
  assert.match((await apply(h, plan, ['c1', 'c1'])).error, /unique/);
  b.remove();
  assert.equal((await apply(h, plan, ['c1'])).error, undefined); assert.equal(a.width, 200);
});

test('plans expire, are bounded to ten, and do not survive plugin restart', async () => {
  let time = 1000;
  class Clock extends Date { static now() { return time; } }
  const h = pluginHarness({ clock: Clock }); const node = h.node('RECTANGLE', 'A', h.page);
  const old = await preview(h, [entry(node, { name: 'B' })]);
  time += 300000;
  assert.match((await apply(h, old)).error, /expired/);
  const evicted = await preview(h, [entry(node, { name: 'B' })]);
  let newest;
  for (let i = 0; i < 10; i++) newest = await preview(h, [entry(node, { name: 'B' })]);
  assert.match((await apply(h, evicted)).error, /Unknown/);
  assert.match((await apply(pluginHarness(), newest)).error, /Unknown/);
  const original = h.figma.getNodeByIdAsync;
  h.figma.getNodeByIdAsync = async id => { time += 300000; return original(id); };
  assert.match((await apply(h, newest)).error, /expired during lookup/);
  assert.equal(node.name, 'A');
});

test('rejects unsupported shapes, text changes, bindings, components, layout and nested targets', async () => {
  const h = pluginHarness();
  const frame = h.node('FRAME', 'Frame', h.page); const text = h.node('TEXT', 'Text', frame);
  const shape = h.node('RECTANGLE', 'Shape', frame);
  for (const [node, props] of [[text, { characters: 'New' }], [h.node('ELLIPSE', 'Ellipse', h.page), { cornerRadius: 8 }]])
    assert.match((await h.call('preview_changes', { changes: [entry(node, props)] })).error, /does not support/);
  assert.equal((await apply(h, await preview(h, [entry(text, { name: 'Renamed text' })]))).error, undefined);
  shape.boundVariables = { width: { type: 'VARIABLE_ALIAS', id: 'var' } };
  assert.match((await h.call('preview_changes', { changes: [entry(shape, { width: 200 })] })).error, /bound\/styled/);
  shape.boundVariables = {}; shape.fillStyleId = 'style';
  assert.match((await h.call('preview_changes', { changes: [entry(shape, { fill: '#123456' })] })).error, /bound\/styled/);
  shape.fillStyleId = ''; frame.layoutMode = 'HORIZONTAL';
  assert.match((await h.call('preview_changes', { changes: [entry(shape, { visible: false })] })).error, /Auto Layout/);
  assert.equal((await apply(h, await preview(h, [entry(shape, { locked: true })]))).error, undefined);
  frame.layoutMode = 'NONE';
  assert.match((await h.call('preview_changes', { changes: [entry(frame, { name: 'X' }), entry(shape, { name: 'Y' })] })).error, /descendant/);
  const instance = h.node('INSTANCE', 'Instance', h.page); instance.appendChild(shape);
  assert.match((await h.call('preview_changes', { changes: [entry(shape, { name: 'Y' })] })).error, /component or instance/);
});

test('failed write restores earlier and partially changed nodes; failed plan is consumed', async () => {
  const h = pluginHarness(); const a = h.node('RECTANGLE', 'A', h.page); const b = h.node('RECTANGLE', 'B', h.page);
  const plan = await preview(h, [entry(a, { x: 50, width: 200 }), entry(b, { width: 300, opacity: 0.5 })]);
  let opacity = 1;
  Object.defineProperty(b, 'opacity', { get: () => opacity, set: v => { if (v === 0.5) throw new Error('Setter failure'); opacity = v; } });
  assert.match((await apply(h, plan)).error, /Setter failure.*Original layer states restored/);
  assert.equal(a.width, 100); assert.equal(a.x, 0); assert.equal(b.width, 100); assert.equal(b.opacity, 1);
  assert.match((await apply(h, plan)).error, /consumed/);
});

test('readback detects Figma normalization and rollback errors are explicit', async () => {
  const h = pluginHarness(); const node = h.node('RECTANGLE', 'A', h.page);
  const plan = await preview(h, [entry(node, { width: 200 })]);
  node.resize = (w, height) => { node.width = w === 200 ? 180 : w; node.height = height; };
  assert.match((await apply(h, plan)).error, /did not retain planned width.*Original layer states restored/);
  const next = await preview(h, [entry(node, { width: 200 })]);
  node.resize = () => { node.width = 180; throw new Error('Resize failure'); };
  assert.match((await apply(h, next)).error, /Rollback incomplete.*Plan consumed/);
});

test('mixed corner radii restore individually, while mixed stroke weights are rejected', async () => {
  const h = pluginHarness(); const node = h.node('RECTANGLE', 'A', h.page);
  const corners = ['topLeftRadius', 'topRightRadius', 'bottomLeftRadius', 'bottomRightRadius'];
  corners.forEach((key, i) => { node[key] = i + 1; });
  Object.defineProperty(node, 'cornerRadius', {
    get: () => corners.every(key => node[key] === node.topLeftRadius) ? node.topLeftRadius : h.figma.mixed,
    set: value => { assert.equal(typeof value, 'number'); corners.forEach(key => { node[key] = value; }); },
  });
  const plan = await preview(h, [entry(node, { cornerRadius: 8, opacity: 0.5 })]);
  Object.defineProperty(node, 'opacity', { get: () => 1, set: value => { if (value !== 1) throw new Error('Opacity failed'); } });
  assert.match((await apply(h, plan)).error, /Original layer states restored/);
  assert.deepEqual(corners.map(key => node[key]), [1, 2, 3, 4]);
  node.strokeWeight = h.figma.mixed;
  assert.match((await h.call('preview_changes', { changes: [entry(node, { strokeWeight: 2 })] })).error, /mixed individual stroke/);
});

test('one-pixel changes at large coordinates remain selectable and resize side effects roll back', async () => {
  const h = pluginHarness(); const node = h.node('RECTANGLE', 'A', h.page); node.x = 999999;
  const plan = await preview(h, [entry(node, { x: 1000000 })]);
  assert.equal(plan.changes.length, 1); assert.equal((await apply(h, plan)).error, undefined);
  const next = await preview(h, [entry(node, { width: 200 })]);
  node.resize = (width, height) => { node.width = width; node.height = height; node.x += 10; };
  assert.match((await apply(h, next)).error, /changed unselected x.*Original layer states restored/);
  assert.equal(node.x, 1000000); assert.equal(node.width, 100);
});

test('input and snapshot bounds fail before writing', async () => {
  const schema = z.object(previewChangesSchema).strict(); const applySchema = z.object(applyChangesSchema).strict();
  for (const props of [{}, { width: -1 }, { x: Infinity }, { opacity: 2 }, { characters: 'hidden' }, { fill: 'red' }])
    assert.equal(schema.safeParse({ changes: [{ nodeId: 'a', props }] }).success, false);
  assert.equal(schema.safeParse({ changes: [entry({ id: 'a' }, { name: 'A' }), entry({ id: 'a' }, { name: 'B' })] }).success, false);
  assert.equal(applySchema.safeParse({ planId: 'x', changeIds: ['c1'], props: { width: 100 } }).success, false);
  const h = pluginHarness(); const node = h.node('TEXT', 'Text', h.page); node.characters = 'x'.repeat(40000);
  assert.match((await h.call('preview_changes', { changes: [entry(node, { name: 'New' })] })).error, /too large/);
  assert.equal(node.name, 'Text'); assert.equal(h.undoCount, 0);
});

test('a no-op layout property does not invalidate a metadata-only plan', async () => {
  const h = pluginHarness(), frame = h.node('FRAME', 'Old', h.page);
  Object.assign(frame, { layoutMode: 'VERTICAL', primaryAxisSizingMode: 'FIXED', counterAxisSizingMode: 'FIXED' });
  const plan = await preview(h, [entry(frame, { name: 'New', width: frame.width })]);
  assert.deepEqual(plan.changes.map(c => c.property), ['name']);
  assert.equal((await apply(h, plan)).error, undefined); assert.equal(frame.name, 'New');
});
