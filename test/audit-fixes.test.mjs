import test from 'node:test';
import assert from 'node:assert/strict';
import { pluginHarness } from './plugin-harness.mjs';

const fixture = () => {
  const h = pluginHarness(), frame = h.node('FRAME', 'Screen', h.page);
  frame.width = 200; frame.height = 120;
  const shape = h.node('RECTANGLE', 'Outside', frame); shape.x = 180; shape.y = -10; shape.width = 40; shape.height = 30;
  return { h, frame, shape };
};
async function propose({ h, frame, shape }, ids = [shape.id]) {
  const result = await h.call('preview_audit_fixes', { nodeId: frame.id, nodeIds: ids });
  assert.equal(result.error, undefined); return result.result;
}
test('audit → selected bounds fix → apply → repeat audit removes the finding without resizing', async () => {
  const f = fixture(), { h, frame, shape } = f;
  const before = await h.call('audit_design', { nodeId: frame.id, checkTextStyles: false });
  assert.equal(before.result.findings[0].code, 'OUTSIDE_PARENT');
  const proposal = await propose(f);
  assert.deepEqual(proposal.plan.changes.map(c => [c.property, c.before, c.after]), [['x', 180, 160], ['y', -10, 0]]);
  assert.equal(shape.x, 180); assert.equal(h.undoCount, 0);
  const applied = await h.call('apply_changes', { planId: proposal.plan.planId, changeIds: proposal.plan.changes.map(c => c.id) });
  assert.equal(applied.error, undefined); assert.equal(shape.width, 40); assert.equal(shape.height, 30);
  assert.equal((await h.call('audit_design', { nodeId: frame.id, checkTextStyles: false })).result.findings.length, 0);
});
test('ambiguous and unsupported findings return reasons without modifying layers', async () => {
  for (const change of [
    f => { f.shape.width = 250; }, f => { f.frame.layoutMode = 'HORIZONTAL'; },
    f => { f.shape.boundVariables = { width: { type: 'VARIABLE_ALIAS', id: 'token' } }; },
    f => { f.frame.visible = false; }, f => { f.shape.locked = true; },
    f => { f.shape.relativeTransform = [[0, -1, 180], [1, 0, -10]]; },
    f => { f.frame.overflowDirection = 'HORIZONTAL'; },
    f => { f.h.node('RECTANGLE', 'Mask', f.frame).isMask = true; },
    f => { f.h.node('RECTANGLE', 'Ancestor mask', f.h.page).isMask = true; },
    f => { f.h.page.appendChild(f.shape); }, f => { f.shape.x = 0; f.shape.y = 0; },
  ]) {
    const f = fixture(); change(f); const before = [f.shape.x, f.shape.y, f.shape.width];
    const result = await propose(f);
    assert.equal(result.plan, null); assert.equal(result.skipped.length, 1); assert.ok(result.skipped[0].reason);
    assert.deepEqual([f.shape.x, f.shape.y, f.shape.width], before); assert.equal(f.h.undoCount, 0);
  }
});
test('proposal uses state after all async lookups and rejects later parent changes', async () => {
  const f = fixture(); const b = f.h.node('ELLIPSE', 'Second', f.frame); b.x = -10;
  const lookup = f.h.figma.getNodeByIdAsync;
  f.h.figma.getNodeByIdAsync = async id => { const n = await lookup(id); if (id === b.id) f.shape.x = -20; return n; };
  const { plan } = await propose(f, [f.shape.id, b.id]);
  assert.equal(plan.changes.find(c => c.nodeId === f.shape.id && c.property === 'x').after, 0);
  f.frame.width = 300;
  assert.match((await f.h.call('apply_changes', { planId: plan.planId, changeIds: plan.changes.map(c => c.id) })).error, /context changed/);
  assert.equal(b.x, -10);
});
test('missing layers are reported while supported selected findings still get a plan', async () => {
  const f = fixture(); const result = await propose(f, ['missing', f.shape.id]);
  assert.equal(result.skipped.length, 1); assert.equal(result.plan.changes.length, 2);
  const outside = f.h.node('TEXT', 'Other page text', f.h.page);
  assert.equal((await propose(f, [outside.id])).plan, null);
});
test('changing scrolling or adding a mask after preview invalidates the fix', async () => {
  for (const kind of ['scroll', 'mask', 'opacity']) {
    const f = fixture(); const { plan } = await propose(f);
    if (kind === 'scroll') f.frame.overflowDirection = 'HORIZONTAL';
    if (kind === 'mask') f.h.node('RECTANGLE', 'New mask', f.frame).isMask = true;
    if (kind === 'opacity') f.frame.opacity = 0;
    assert.match((await f.h.call('apply_changes', { planId: plan.planId, changeIds: plan.changes.map(c => c.id) })).error, /context changed/);
    assert.equal(f.shape.x, 180);
  }
});

function textFixture() {
  const h = pluginHarness(), frame = h.node('FRAME', 'Text card', h.page);
  frame.width = 500; frame.height = 300;
  const text = h.node('TEXT', 'Description', frame);
  Object.assign(text, { x: 20, y: 20, width: 200, height: 20, characters: 'Two lines', textAlignVertical: 'TOP',
    absoluteBoundingBox: { x: 20, y: 20, width: 200, height: 20 },
    absoluteRenderBounds: { x: 21, y: 23, width: 190, height: 32 } });
  text.resize = (w, h) => { text.width = w; text.height = h; text.absoluteBoundingBox = { x: 20, y: 20, width: w, height: h }; };
  return { h, frame, shape: text };
}
test('fixed text overflow gets a read-only height plan, preserves glyphs and clears audit', async () => {
  const f = textFixture(); const { plan } = await propose(f);
  assert.deepEqual(plan.changes.map(c => [c.property, c.before, c.after]), [['height', 20, 35]]);
  assert.equal(f.shape.height, 20); assert.equal(f.h.undoCount, 0);
  assert.equal((await f.h.call('apply_changes', { planId: plan.planId, changeIds: ['c1'] })).error, undefined);
  assert.equal(f.shape.width, 200); assert.equal(f.shape.characters, 'Two lines'); assert.equal(f.h.fonts.length, 1);
  assert.equal((await f.h.call('audit_design', { nodeId: f.frame.id, checkTextStyles: false })).result.findingCount, 0);
});
test('text fixes skip sibling collisions, transformed ancestors, missing fonts and horizontal overflow', async () => {
  for (const change of [
    f => { const s = f.h.node('RECTANGLE', 'Next field', f.frame); s.absoluteBoundingBox = { x: 30, y: 48, width: 100, height: 30 }; },
    f => { f.frame.relativeTransform = [[0, -1, 0], [1, 0, 0]]; },
    f => { f.shape.hasMissingFont = true; }, f => { f.shape.textAlignVertical = 'CENTER'; },
    f => { f.shape.absoluteRenderBounds.width = 210; }, f => { f.frame.height = 40; },
  ]) {
    const f = textFixture(); change(f); const result = await propose(f);
    assert.equal(result.plan, null); assert.equal(result.skipped.length, 1); assert.equal(f.shape.height, 20);
  }
});
test('text plan conflicts on new siblings, font loading changes or typography edits', async () => {
  for (const kind of ['sibling', 'font-loading', 'line-height', 'text-wrap']) {
    const f = textFixture(); const { plan } = await propose(f);
    if (kind === 'sibling') f.h.node('RECTANGLE', 'New sibling', f.frame);
    if (kind === 'line-height') f.shape.lineHeight = { unit: 'PIXELS', value: 50 };
    if (kind === 'text-wrap') f.shape.textWrapStyle = 'BALANCE';
    if (kind === 'font-loading') f.h.figma.loadFontAsync = async () => { f.shape.characters = 'User edit'; };
    assert.match((await f.h.call('apply_changes', { planId: plan.planId, changeIds: ['c1'] })).error, /context changed/);
    assert.equal(f.shape.height, 20); assert.equal(f.h.undoCount, 0);
  }
});
