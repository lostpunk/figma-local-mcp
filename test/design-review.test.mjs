import test from 'node:test';
import assert from 'node:assert/strict';
import { pluginHarness } from './plugin-harness.mjs';
import { z } from 'zod';
import { auditSchema, designFixesSchema } from '../src/audit-schema.mjs';
const paint = { type: 'SOLID', color: { r: 0.2, g: 0.3, b: 0.4 }, opacity: 1 };
function fixture() {
  const h = pluginHarness(), n = h.node('RECTANGLE', 'Surface', h.page);
  n.fills = [structuredClone(paint)];
  const collection = h.figma.variables.createVariableCollection('Project');
  const variable = h.figma.variables.createVariable('surface', collection, 'COLOR');
  variable.setValueForMode('mode:1', { ...paint.color, a: 1 });
  variable.resolveForConsumer = () => ({ resolvedType: 'COLOR', value: variable.valuesByMode['mode:1'] });
  return { h, n, variable, rules: { colorVariableIds: [variable.id] } };
}
const audit = f => f.h.call('audit_design', { nodeId: f.h.page.id, checkTextStyles: false, rules: { designSystem: f.rules } });
const preview = (f, ids = [f.n.id]) => f.h.call('preview_design_fixes', { nodeId: f.h.page.id, nodeIds: ids, rules: f.rules });
const apply = (f, p) => f.h.call('apply_changes', { planId: p.planId, changeIds: p.changes.map(c => c.id) });
test('project audit → exact color binding preview → apply preserves appearance and clears finding', async () => {
  const f = fixture(); const before = (await audit(f)).result;
  assert.equal(before.findings[0].code, 'UNBOUND_COLOR');
  assert.deepEqual(before.findings[0].evidence.candidateVariableIds, [f.variable.id]);
  const p = (await preview(f)).result.plan;
  assert.equal(p.changes[0].property, 'fillVariableId'); assert.equal(f.n.fills[0].boundVariables, undefined);
  assert.equal((await apply(f, p)).error, undefined);
  assert.deepEqual(f.n.fills[0].color, paint.color); assert.equal(f.n.fills[0].boundVariables.color.id, f.variable.id);
  assert.equal((await audit(f)).result.findingCount, 0);
});
test('ambiguous matches, changed variables and explicit exceptions do not silently replace bindings', async () => {
  const f = fixture(); const p = (await preview(f)).result.plan;
  f.variable.valuesByMode['mode:1'].r = 0.9;
  assert.match((await apply(f, p)).error, /changed/); assert.equal(f.n.fills[0].boundVariables, undefined);
  f.variable.valuesByMode['mode:1'].r = 0.2;
  f.rules.colorVariableIds.push(f.variable.id);
  assert.equal((await preview(f)).result.plan, null);
  f.rules.ignoreNodeIds = [f.n.id];
  const report = (await audit(f)).result;
  assert.equal(report.findingCount, 0); assert.equal(report.coverage.designSystem.ignored, 1);
});
test('invalid project IDs mark incomplete coverage and invalid schema is rejected', async () => {
  const f = fixture(); f.rules.colorVariableIds = ['missing'];
  const report = (await audit(f)).result;
  assert.equal(report.complete, false); assert.equal(report.findings[0].code, 'DESIGN_RULES_INVALID');
  assert.equal(z.object(auditSchema).safeParse({ nodeId: 'a', rules: { designSystem: { colorVariableIds: [] } } }).success, false);
  assert.equal(z.object(designFixesSchema).safeParse({ nodeId: 'a', nodeIds: ['b'], rules: { unknown: true } }).success, false);
});
test('uniform exact typography can bind a style; missing matches are not guessed', async () => {
  const f = fixture(); f.n = f.h.node('TEXT', 'Caption', f.h.page); f.n.characters = 'Preserve this text';
  const style = f.h.figma.createTextStyle(); style.lineHeight = { unit: 'AUTO' };
  f.rules = { textStyleIds: [style.id] };
  assert.equal((await audit(f)).result.findings[0].code, 'TEXT_STYLE_OUTSIDE_SYSTEM');
  const p = (await preview(f)).result.plan;
  assert.equal((await apply(f, p)).error, undefined); assert.equal(f.n.textStyleId, style.id); assert.equal(f.n.characters, 'Preserve this text');
  f.n.textStyleId = ''; f.n.fontSize = 14;
  assert.equal((await preview(f)).result.plan, null);
});
test('style changes during font loading and unexpected style side effects are detected', async () => {
  for (const kind of ['load', 'setter']) {
    const f = fixture(); f.n = f.h.node('TEXT', 'Caption', f.h.page);
    const style = f.h.figma.createTextStyle(); style.lineHeight = { unit: 'AUTO' }; f.rules = { textStyleIds: [style.id] };
    const p = (await preview(f)).result.plan;
    if (kind === 'load') f.h.figma.loadFontAsync = async () => { style.fontSize = 15; };
    else f.n.setTextStyleIdAsync = async id => { f.n.textStyleId = id; f.n.characters = 'Concurrent edit'; };
    assert.match((await apply(f, p)).error, kind === 'load' ? /changed/ : /other layer properties.*Rollback incomplete/);
    if (kind === 'load') assert.equal(f.n.textStyleId, ''); else assert.equal(f.n.characters, 'Concurrent edit');
  }
});
test('component audit accepts members of a project set and reports other instance sources', async () => {
  const f = fixture(); const component = f.h.node('COMPONENT', 'Button', f.h.page);
  component.name = 'State=Default'; const set = f.h.figma.combineAsVariants([component], f.h.page);
  const instance = component.createInstance();
  f.rules = { componentIds: [set.id] };
  assert.equal((await audit(f)).result.findingCount, 0);
  const other = f.h.node('COMPONENT', 'Other', f.h.page); f.rules.componentIds = [other.id];
  assert.equal((await audit(f)).result.findings.find(x => x.nodeId === instance.id).code, 'COMPONENT_OUTSIDE_SYSTEM');
  assert.equal((await preview(f, [instance.id])).result.plan, null);
});

test('variable changed during an earlier asynchronous style write is rechecked before binding', async () => {
  const f = fixture(), text = f.h.node('TEXT', 'Text', f.h.page);
  const style = f.h.figma.createTextStyle(); style.lineHeight = { unit: 'AUTO' }; f.rules.textStyleIds = [style.id];
  const setter = text.setTextStyleIdAsync.bind(text);
  text.setTextStyleIdAsync = async id => { await setter(id); f.variable.valuesByMode['mode:1'].r = 0.8; };
  const plan = (await preview(f, [text.id, f.n.id])).result.plan;
  const result = await apply(f, plan);
  assert.match(result.error, /changed/); assert.equal(f.n.fills[0].boundVariables, undefined);
});

function textBindingFixture() {
  const f = fixture();
  f.n = f.h.node('TEXT', 'Title', f.h.page);
  f.n.fills = [structuredClone(paint)];
  f.n.strokes = [structuredClone(paint)];
  const style = f.h.figma.createTextStyle(); style.lineHeight = { unit: 'AUTO' };
  f.rules.textStyleIds = [style.id];
  return { ...f, style };
}
test('combined color and text-style bindings still apply when the layer is unchanged', async () => {
  const f = textBindingFixture(), plan = (await preview(f)).result.plan;
  assert.equal(plan.changes.length, 3);
  assert.equal((await apply(f, plan)).error, undefined);
  assert.equal(f.n.fills[0].boundVariables.color.id, f.variable.id);
  assert.equal(f.n.strokes[0].boundVariables.color.id, f.variable.id);
  assert.equal(f.n.textStyleId, f.style.id);
});
test('manual paint edits during style assignment survive failure and are never called restored', async () => {
  for (const field of ['fills', 'strokes']) for (const reject of [false, true]) {
    const f = textBindingFixture(), plan = (await preview(f)).result.plan;
    const manual = [{ ...structuredClone(paint), color: { r: 1, g: 0, b: 0 } }];
    const setter = f.n.setTextStyleIdAsync.bind(f.n);
    f.n.setTextStyleIdAsync = async id => {
      await setter(id);
      f.n[field] = structuredClone(manual);
      if (reject) throw new Error('Interrupted style assignment');
    };
    const result = await apply(f, plan);
    assert.match(result.error, /Rollback incomplete/);
    assert.doesNotMatch(result.error, /Original layer states restored/);
    assert.deepEqual(f.n[field], manual);
    assert.match((await apply(f, plan)).error, /consumed/);
  }
});
test('a different same-color binding and a manual style ID during async assignment are preserved', async () => {
  for (const change of ['alias', 'style']) {
    const f = textBindingFixture(), plan = (await preview(f)).result.plan;
    const setter = f.n.setTextStyleIdAsync.bind(f.n);
    f.n.setTextStyleIdAsync = async id => {
      await setter(id);
      if (change === 'alias') f.n.fills[0].boundVariables.color.id = 'manual-variable';
      else f.n.textStyleId = 'manual-style';
    };
    const result = await apply(f, plan);
    assert.match(result.error, /Rollback incomplete/);
    if (change === 'alias') assert.equal(f.n.fills[0].boundVariables.color.id, 'manual-variable');
    else assert.equal(f.n.textStyleId, 'manual-style');
  }
});
test('conflicted text leaves manual paints intact while earlier independent bindings roll back', async () => {
  const f = textBindingFixture(), earlier = f.h.node('RECTANGLE', 'Earlier', f.h.page);
  earlier.fills = [structuredClone(paint)];
  const plan = (await preview(f, [earlier.id, f.n.id])).result.plan;
  const setter = f.n.setTextStyleIdAsync.bind(f.n);
  f.n.setTextStyleIdAsync = async id => { await setter(id); f.n.fills[0].color.r = 1; };
  assert.match((await apply(f, plan)).error, /Rollback incomplete/);
  assert.equal(f.n.fills[0].color.r, 1);
  assert.deepEqual(structuredClone(earlier.fills), [paint]);
});
test('a resource conflict still restores all verified bindings when no manual layer edit occurred', async () => {
  const f = textBindingFixture(), plan = (await preview(f)).result.plan;
  const setter = f.n.setTextStyleIdAsync.bind(f.n);
  f.n.setTextStyleIdAsync = async id => { await setter(id); if (id) f.variable.valuesByMode['mode:1'].r = 0.8; };
  assert.match((await apply(f, plan)).error, /Color or variable mode changed.*Original layer states restored/);
  assert.equal(f.n.textStyleId, '');
  assert.deepEqual(structuredClone(f.n.fills), [paint]);
  assert.deepEqual(structuredClone(f.n.strokes), [paint]);
});
test('ancestor edits during asynchronous style assignment are not accepted as a new baseline', async () => {
  const f = textBindingFixture(), parent = f.h.node('FRAME', 'Container', f.h.page);
  parent.appendChild(f.n);
  const plan = (await preview(f)).result.plan, setter = f.n.setTextStyleIdAsync.bind(f.n);
  f.n.setTextStyleIdAsync = async id => { await setter(id); parent.width = 300; };
  assert.match((await apply(f, plan)).error, /context.*Rollback incomplete/);
  assert.equal(parent.width, 300);
});
test('text-wrap style participates in exact matching and changes invalidate a binding plan', async () => {
  const f = textBindingFixture(); f.rules = { textStyleIds: [f.style.id] };
  f.style.textWrapStyle = 'BALANCE';
  assert.deepEqual((await audit(f)).result.findings.find(x => x.nodeId === f.n.id).evidence.candidateStyleIds, []);
  assert.equal((await preview(f)).result.plan, null);
  f.n.textWrapStyle = 'BALANCE';
  const matched = (await preview(f)).result.plan;
  assert.equal((await apply(f, matched)).error, undefined);
  assert.equal(f.n.textWrapStyle, 'BALANCE');
  f.n.textStyleId = '';
  for (const target of [f.n, f.style]) {
    const plan = (await preview(f)).result.plan;
    target.textWrapStyle = 'AUTO';
    assert.match((await apply(f, plan)).error, /changed/);
    assert.equal(f.n.textStyleId, '');
    target.textWrapStyle = 'BALANCE';
  }
});
test('text-wrap edits during assignment are preserved and reported as an incomplete rollback', async () => {
  const f = textBindingFixture(), plan = (await preview(f)).result.plan;
  const setter = f.n.setTextStyleIdAsync.bind(f.n);
  f.n.setTextStyleIdAsync = async id => { await setter(id); f.n.textWrapStyle = 'BALANCE'; };
  assert.match((await apply(f, plan)).error, /Rollback incomplete/);
  assert.equal(f.n.textWrapStyle, 'BALANCE');
});
