import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { auditSchema } from '../src/audit-schema.mjs';
import { pluginHarness } from './plugin-harness.mjs';

const schema = z.object(auditSchema).strict();
async function audit(h, node, args = {}) {
  const response = await h.call('audit_design', schema.parse({ nodeId: node.id, ...args }));
  assert.equal(response.error, undefined);
  return response.result;
}
function place(node, x, y, width = 20, height = 20) {
  Object.assign(node, { x, y, width, height, relativeTransform: [[1, 0, x], [0, 1, y]] });
  return node;
}
const codes = report => report.findings.map(f => f.code);

test('audit reports bounds and supplied spacing without mutating document, loading fonts or undo', async () => {
  const h = pluginHarness();
  const frame = place(h.node('FRAME', 'Screen', h.page), 400, 400, 200, 200);
  frame.layoutMode = 'VERTICAL'; frame.paddingTop = 13; frame.itemSpacing = 16;
  const child = place(h.node('RECTANGLE', 'Decoration', frame), 190, 15);
  const snapshot = () => JSON.stringify([...h.nodes.values()].map(n => [n.id, n.name, n.x, n.y, n.width, n.height, n.visible]));
  const before = snapshot();
  const report = await audit(h, frame, { rules: { spacing: [4, 8, 16] } });
  assert.deepEqual(codes(report), ['SPACING_OFF_SCALE', 'OUTSIDE_PARENT']);
  assert.equal(report.findings[1].nodeId, child.id);
  assert.equal(report.findings[1].evidence.parentId, frame.id);
  assert.equal(report.complete, true);
  assert.equal(snapshot(), before);
  assert.equal(h.undoCount, 0);
  assert.equal(h.fonts.length, 0);
  assert.equal(h.figma.currentPage, h.page);
  assert.ok(!codes(await audit(h, frame)).includes('SPACING_OFF_SCALE'));
});

test('geometry uses parent-relative transforms, skips scrolling axes and hidden descendants', async () => {
  const h = pluginHarness();
  const frame = place(h.node('FRAME', 'Rotated', h.page), 500, 500, 100, 100);
  frame.rotation = 45;
  const inside = place(h.node('RECTANGLE', 'Inside', frame), 50, 50);
  inside.relativeTransform = [[0, -1, 50], [1, 0, 50]];
  const outside = place(h.node('RECTANGLE', 'Scrollable', frame), 0, 180);
  const hidden = place(h.node('FRAME', 'Hidden', frame), -100, -100);
  hidden.visible = false;
  place(h.node('RECTANGLE', 'Skip this subtree', hidden), -400, -400);
  frame.overflowDirection = 'VERTICAL';
  let report = await audit(h, frame);
  assert.deepEqual(codes(report), []);
  assert.equal(report.coverage.hiddenSubtrees, 1);
  assert.equal(report.coverage.checked, 3);
  outside.relativeTransform[0][2] = 150;
  report = await audit(h, frame);
  assert.equal(report.findings[0].nodeId, outside.id);
  assert.equal(report.findings.length, 1);
  assert.equal((await audit(h, hidden.children[0])).coverage.checked, 0);
});

test('text distinguishes missing fonts, possible render overflow and configured ellipsis', async () => {
  const h = pluginHarness();
  const text = h.node('TEXT', 'Private contents should not enter report', h.page);
  text.characters = 'do-not-copy-this-text';
  text.hasMissingFont = true;
  text.absoluteBoundingBox = { x: 0, y: 0, width: 100, height: 20 };
  text.absoluteRenderBounds = { x: 0, y: 0, width: 100, height: 40 };
  let report = await audit(h, text);
  assert.deepEqual(codes(report), ['MISSING_FONT', 'TEXT_RENDER_OUTSIDE_BOX']);
  assert.ok(!JSON.stringify(report).includes(text.characters));
  text.textTruncation = 'ENDING'; text.maxLines = 1;
  report = await audit(h, text);
  assert.deepEqual(codes(report), ['MISSING_FONT', 'TEXT_TRUNCATION_ENABLED']);
  assert.equal(report.findings[1].severity, 'info');
  text.textTruncation = 'DISABLED'; text.hasMissingFont = false;
  text.effects = [{ type: 'DROP_SHADOW', visible: true }];
  assert.deepEqual(codes(await audit(h, text)), []);
  text.effects = []; text.strokes = [{ type: 'SOLID', visible: true }];
  assert.deepEqual(codes(await audit(h, text)), []);
});

test('only exact required variant properties are checked; unresolved targets are explicit', async () => {
  const h = pluginHarness();
  const set = h.node('COMPONENT_SET', 'Button', h.page);
  set.componentPropertyDefinitions = { State: { type: 'VARIANT', variantOptions: ['Default', 'Hover'] } };
  const rules = { componentStates: [{ nodeId: set.id, property: 'State', required: ['Default', 'Hover', 'Focus'] }] };
  let report = await audit(h, h.page, { rules });
  assert.deepEqual(report.findings[0].evidence.missing, ['Focus']);
  assert.equal(report.coverage.stateRulesChecked, 1);
  set.componentPropertyDefinitions.State.variantOptions.push('Focus');
  assert.deepEqual(codes(await audit(h, h.page, { rules })), []);
  report = await audit(h, h.page, { rules: { componentStates: [{ ...rules.componentStates[0], nodeId: 'missing' }] } });
  assert.equal(report.complete, false);
  assert.equal(report.coverage.uncheckedStateRules.length, 1);
  report = await audit(h, h.page, { rules: { componentStates: [{ ...rules.componentStates[0], nodeId: h.page.id }] } });
  assert.ok(codes(report).includes('STATE_RULE_TARGET_INVALID'));
});

test('duplicate text-style names include IDs without merging or conflating distinct names', async () => {
  const h = pluginHarness();
  for (const name of ['Body', 'Body', 'Title']) {
    const style = h.figma.createTextStyle(); style.name = name;
  }
  const report = await audit(h, h.page);
  assert.deepEqual(codes(report), ['DUPLICATE_TEXT_STYLE_NAME']);
  assert.equal(report.findings[0].evidence.styleIds.length, 2);
  assert.equal(h.styles.size, 3);
  assert.equal(h.undoCount, 0);
  assert.deepEqual(codes(await audit(h, h.page, { checkTextStyles: false })), []);
  const limited = await audit(h, h.page, { maxStyles: 1 });
  assert.equal(limited.complete, false);
  assert.equal(limited.coverage.textStyles.truncated, true);
});

test('node and finding limits report incomplete coverage, including at an exact traversal boundary', async () => {
  const h = pluginHarness();
  const frame = place(h.node('FRAME', 'Screen', h.page), 0, 0, 100, 100);
  for (let i = 0; i < 4; i++) place(h.node('RECTANGLE', 'Outside', frame), 200, 200);
  let report = await audit(h, frame, { maxNodes: 2, maxFindings: 1 });
  assert.equal(report.complete, false);
  assert.equal(report.coverage.visited, 2);
  assert.equal(report.coverage.nodesTruncated, true);
  report = await audit(h, frame, { maxNodes: 5, maxFindings: 1 });
  assert.equal(report.coverage.nodesTruncated, false);
  assert.equal(report.findingCount, 4);
  assert.equal(report.findings.length, 1);
  assert.equal(report.coverage.findingsTruncated, true);
  assert.equal((await audit(h, frame, { maxNodes: 5 })).complete, true);
});

test('audit reports partial API failures and continues other checks', async () => {
  const h = pluginHarness();
  const text = h.node('TEXT', 'Unavailable', h.page);
  Object.defineProperty(text, 'hasMissingFont', { get() { throw new Error('Unavailable'); } });
  h.figma.getLocalTextStylesAsync = async () => { throw new Error('No styles'); };
  const report = await audit(h, h.page);
  assert.deepEqual(codes(report), ['NODE_CHECK_FAILED', 'STYLE_CHECK_FAILED']);
  assert.equal(report.complete, false);
  assert.equal(report.coverage.failedChecks, 2);
});

test('spacing allows tolerance/zero and ignores SPACE_BETWEEN gaps and unused rules', async () => {
  const h = pluginHarness();
  const frame = h.node('FRAME', 'Auto', h.page);
  frame.layoutMode = 'HORIZONTAL'; frame.primaryAxisAlignItems = 'SPACE_BETWEEN';
  frame.itemSpacing = 19; frame.paddingLeft = 8.3;
  assert.deepEqual(codes(await audit(h, frame, { rules: { spacing: [8, 16] } })), []);
  frame.layoutMode = 'NONE'; frame.paddingLeft = 123;
  assert.deepEqual(codes(await audit(h, frame, { rules: { spacing: [8, 16] } })), []);
});

test('audit schema rejects unbounded traversal, invalid rules and undocumented mutations', () => {
  for (const bad of [{ maxNodes: 10001 }, { tolerance: -1 }, { maxStyles: 2001 },
    { rules: { spacing: [] } }, { rules: { componentStates: [{ nodeId: 'x', required: ['Hover'] }] } }, { autoFix: true }]) {
    assert.equal(schema.safeParse({ nodeId: '1:2', ...bad }).success, false);
  }
});
