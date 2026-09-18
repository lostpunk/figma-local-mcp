import test from 'node:test';
import assert from 'node:assert/strict';
import { pluginHarness } from './plugin-harness.mjs';

function fixture(axis = 'HORIZONTAL') {
  const h = pluginHarness(), frame = h.node('FRAME', 'Stack', h.page);
  Object.assign(frame, { width: 300, height: 200, layoutMode: axis, primaryAxisSizingMode: 'FIXED', counterAxisSizingMode: 'FIXED',
    primaryAxisAlignItems: 'MIN', counterAxisAlignItems: 'MIN', layoutWrap: 'NO_WRAP' });
  const a = h.node('RECTANGLE', 'A', frame), b = h.node('RECTANGLE', 'B', frame);
  for (const c of [a, b]) Object.assign(c, { width: 60, height: 40 });
  function flow() {
    let cursor = axis === 'HORIZONTAL' ? frame.paddingLeft : frame.paddingTop;
    for (const c of [a, b]) {
      c.x = axis === 'HORIZONTAL' ? cursor : frame.paddingLeft;
      c.y = axis === 'VERTICAL' ? cursor : frame.paddingTop;
      cursor += (axis === 'HORIZONTAL' ? c.width : c.height) + frame.itemSpacing;
    }
  }
  for (const key of ['itemSpacing', 'paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight']) {
    let value = frame[key];
    Object.defineProperty(frame, key, { configurable: true, get: () => value, set: v => { value = v; flow(); } });
  }
  flow();
  return { h, frame, a, b };
}
async function preview(f, props) { return f.h.call('preview_changes', { changes: [{ nodeId: f.frame.id, props }] }); }
async function apply(f, plan, ids = plan.changes.map(c => c.id)) { return f.h.call('apply_changes', { planId: plan.planId, changeIds: ids }); }
test('layout predicts child movement without mutations and applies a coherent group', async () => {
  for (const axis of ['HORIZONTAL', 'VERTICAL']) {
    const f = fixture(axis); const { result: plan, error } = await preview(f, { itemSpacing: 16, paddingLeft: 20, paddingTop: 12 });
    assert.equal(error, undefined); assert.equal(f.frame.itemSpacing, 0); assert.equal(f.h.undoCount, 0);
    assert.deepEqual(plan.layoutEffects[0].children[1].after, { x: axis === 'HORIZONTAL' ? 96 : 20, y: axis === 'VERTICAL' ? 68 : 12, width: 60, height: 40 });
    assert.match((await apply(f, plan, ['c1'])).error, /Select all changes/);
    assert.equal((await apply(f, plan)).error, undefined);
    assert.equal(f.b[axis === 'HORIZONTAL' ? 'x' : 'y'], axis === 'HORIZONTAL' ? 96 : 68);
  }
});
test('layout refuses unsupported sizes and detects descendant/context edits', async () => {
  for (const change of [f => { f.frame.layoutWrap = 'WRAP'; }, f => { f.frame.primaryAxisSizingMode = 'AUTO'; },
    f => { f.a.layoutGrow = 1; }, f => { f.a.layoutPositioning = 'ABSOLUTE'; }, f => { f.frame.width = 100; }]) {
    const f = fixture(); change(f); assert.ok((await preview(f, { itemSpacing: 16 })).error); assert.equal(f.h.undoCount, 0);
  }
  const f = fixture(); const p = (await preview(f, { itemSpacing: 16 })).result;
  f.a.name = 'User changed child'; assert.match((await apply(f, p)).error, /context changed/); assert.equal(f.frame.itemSpacing, 0);
});
test('layout readback detects engine disagreement and reports rollback status', async () => {
  const f = fixture(); const p = (await preview(f, { itemSpacing: 16 })).result;
  let gap = 0;
  Object.defineProperty(f.frame, 'itemSpacing', { configurable: true, get: () => gap, set: v => { gap = v; f.b.x = v === 0 ? 60 : 999; } });
  assert.match((await apply(f, p)).error, /layout differs.*Original layer states restored/);
  assert.equal(f.frame.itemSpacing, 0); assert.equal(f.b.x, 60);
});

test('layout preserves unrelated color bindings and refuses to overwrite spacing tokens', async () => {
  const f = fixture();
  f.frame.fillStyleId = 'paint-style'; f.frame.boundVariables = { fills: [{ type: 'VARIABLE_ALIAS', id: 'color' }] };
  const p = (await preview(f, { itemSpacing: 16 })).result;
  assert.equal((await apply(f, p)).error, undefined);
  assert.equal(f.frame.fillStyleId, 'paint-style'); assert.equal(f.frame.boundVariables.fills[0].id, 'color');
  f.frame.boundVariables.itemSpacing = { type: 'VARIABLE_ALIAS', id: 'spacing' };
  assert.match((await preview(f, { itemSpacing: 24 })).error, /bound sizing/);
});

test('layout can be locked after applying without confusing post-write state with eligibility', async () => {
  const f = fixture(); const p = (await preview(f, { itemSpacing: 16, locked: true })).result;
  assert.equal((await apply(f, p)).error, undefined);
  assert.equal(f.frame.itemSpacing, 16); assert.equal(f.frame.locked, true);
});

function iconMenu() {
  const h = pluginHarness(), frame = h.node('FRAME', 'Navigation', h.page);
  Object.assign(frame, { width: 300, height: 240, layoutMode: 'VERTICAL', primaryAxisSizingMode: 'FIXED', counterAxisSizingMode: 'FIXED' });
  const rows = [], paths = [], labels = [];
  for (let i = 0; i < 4; i++) {
    const row = h.node('FRAME', 'Menu row', frame); rows.push(row);
    Object.assign(row, { width: 280, height: 40, x: 0, y: i * 40 });
    const icon = h.node('INSTANCE', 'Icon', row);
    for (let j = 0; j < 10; j++) {
      const path = h.node('VECTOR', 'Icon path', icon); paths.push(path);
      Object.assign(path, { width: 16, height: 16, constraints: { horizontal: 'SCALE', vertical: 'SCALE' },
        fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 }, opacity: 1 }],
        absoluteRenderBounds: { x: 0, y: 0, width: 16, height: 16 },
        isMask: false, fillStyleId: '', strokeStyleId: '', effectStyleId: '', layoutGrow: 0, layoutAlign: 'INHERIT' });
    }
    const label = h.node('TEXT', 'Label', row); labels.push(label); label.characters = 'Menu item';
  }
  let gap = 0;
  Object.defineProperty(frame, 'itemSpacing', { get: () => gap, set: v => { gap = v; rows.forEach((row, i) => { row.y = i * (40 + v); }); } });
  return { h, frame, paths, rows, labels };
}
test('a four-row menu with component icons fits the snapshot budget without dropping descendant checks', async () => {
  const f = iconMenu(), p = await preview(f, { itemSpacing: 8 });
  assert.equal(p.error, undefined);
  assert.equal((await apply(f, p.result)).error, undefined);
  assert.equal(f.rows[3].y, 144);
  for (const change of [f => { f.paths[20].fills[0].color.r = 0.5; },
    f => { f.paths[20].minWidth = null; }, f => { f.labels[0].textWrapStyle = 'BALANCE'; },
    f => { f.h.node('VECTOR', 'New path', f.paths[0].parent); }]) {
    const f = iconMenu(), p = (await preview(f, { itemSpacing: 8 })).result;
    change(f);
    assert.match((await apply(f, p)).error, /context changed/);
    assert.equal(f.frame.itemSpacing, 0);
  }
});
