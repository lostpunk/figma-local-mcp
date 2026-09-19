import test from 'node:test';
import assert from 'node:assert/strict';
import { pluginHarness } from './plugin-harness.mjs';

const result = async (h, command, args) => {
  const r = await h.call(command, args); assert.equal(r.error, undefined); return r.result;
};
function fixture() {
  const h = pluginHarness(), c = h.figma.variables.createVariableCollection('Theme');
  const a = h.figma.variables.createVariable('surface', c, 'COLOR');
  a.setValueForMode(c.defaultModeId, { r: 1, g: 1, b: 1 });
  const b = h.figma.variables.createVariable('alias', c, 'COLOR');
  b.setValueForMode(c.defaultModeId, { type: 'VARIABLE_ALIAS', id: a.id });
  return { h, c, a, b };
}
function modeNode(h, c, parent = h.page) {
  const n = h.node('FRAME', 'Consumer', parent);
  n.explicitVariableModes = {};
  Object.defineProperty(n, 'resolvedVariableModes', { get() {
    return { [c.id]: this.explicitVariableModes[c.id] ?? this.parent?.resolvedVariableModes?.[c.id] ?? c.defaultModeId };
  }, configurable: true });
  n.setExplicitVariableModeForCollection = (collection, mode) => { assert.equal(collection, c); n.explicitVariableModes[c.id] = mode; };
  n.clearExplicitVariableModeForCollection = collection => { assert.equal(collection, c); delete n.explicitVariableModes[c.id]; };
  return n;
}

test('library listing is read-only, sorted and paginated with revision checks', async () => {
  const h = pluginHarness();
  const list = ['b', 'a'].map(key => ({ key, name: key, libraryName: 'Example' }));
  h.figma.teamLibrary = { async getAvailableLibraryVariableCollectionsAsync() { return list; },
    async getVariablesInLibraryCollectionAsync(key) { assert.equal(key, 'a'); return [{ key: 'v1', name: 'Token', resolvedType: 'COLOR' }]; } };
  const one = await result(h, 'get_library_variables', { limit: 1 });
  assert.equal(one.items[0].key, 'a'); assert.equal(one.nextOffset, 1);
  const two = await result(h, 'get_library_variables', { offset: 1, revision: one.revision });
  assert.equal(two.items[0].key, 'b'); assert.equal(two.complete, true);
  assert.match((await h.call('get_library_variables', { offset: 1 })).error, /LIBRARIES_CHANGED/);
  list[0].name = 'Changed';
  assert.match((await h.call('get_library_variables', { offset: 1, revision: one.revision })).error, /LIBRARIES_CHANGED/);
  assert.equal((await result(h, 'get_library_variables', { collectionKey: 'a' })).items[0].key, 'v1');
  assert.equal(h.undoCount, 0);
});

test('library access failure and oversized entries are actionable without an import', async () => {
  const h = pluginHarness();
  assert.match((await h.call('get_library_variables')).error, /LIBRARY_ACCESS_FAILED/);
  h.figma.teamLibrary = { async getAvailableLibraryVariableCollectionsAsync() { return [{ key: 'a', name: '🙂'.repeat(4000), libraryName: 'Example' }]; } };
  const small = await result(h, 'get_library_variables', { maxResponseBytes: 4096 });
  assert.equal(small.blocked, true); assert.equal(small.nextOffset, 0);
  assert.ok(Buffer.byteLength(JSON.stringify(small)) < 4096);
  assert.equal((await result(h, 'get_library_variables', { maxResponseBytes: 65536 })).complete, true);
  assert.equal(h.undoCount, 0);
});

test('imports dispatch by kind, return reusable IDs and never create an instance', async () => {
  const { h, c, a } = fixture();
  const component = h.node('COMPONENT', 'Library Button', h.page);
  component.key = 'button-key'; component.remote = true;
  const set = h.node('COMPONENT_SET', 'Library Button set', h.page); set.key = 'set-key'; set.remote = true;
  a.key = 'token-key'; a.remote = true;
  const seen = [];
  h.figma.importComponentByKeyAsync = async key => { seen.push(key); return component; };
  h.figma.importComponentSetByKeyAsync = async key => { seen.push(key); return set; };
  h.figma.variables.importVariableByKeyAsync = async key => { seen.push(key); return a; };
  const count = h.nodes.size;
  assert.equal((await result(h, 'import_library_asset', { kind: 'component', key: 'button-key' })).id, component.id);
  assert.equal((await result(h, 'import_library_asset', { kind: 'componentSet', key: 'set-key' })).id, set.id);
  assert.equal((await result(h, 'import_library_asset', { kind: 'variable', key: 'token-key' })).collectionId, c.id);
  assert.deepEqual(seen, ['button-key', 'set-key', 'token-key']); assert.equal(h.nodes.size, count);
  h.figma.importComponentByKeyAsync = async () => { throw new Error('Access denied'); };
  assert.match((await h.call('import_library_asset', { kind: 'component', key: 'missing' })).error, /LIBRARY_IMPORT_FAILED/);
  assert.equal(h.nodes.size, count);
});

test('library failures retain the bounded API cause but redact URLs and credentials', async () => {
  const h = pluginHarness();
  h.figma.teamLibrary = { async getAvailableLibraryVariableCollectionsAsync() {
    throw new Error('Missing teamlibrary permission https://example.com/private token=secret ' + 'a'.repeat(64));
  } };
  const failed = await h.call('get_library_variables');
  assert.match(failed.error, /Missing teamlibrary permission/);
  assert.match(failed.error, /re-import/);
  assert.ok(!failed.error.includes('example.com'));
  assert.ok(!failed.error.includes('token=secret'));
  assert.ok(!failed.error.includes('a'.repeat(64)));
  assert.equal(h.undoCount, 0);
});

test('mode creation previews then copies source values/aliases without changing defaults or old modes', async () => {
  const { h, c, a, b } = fixture();
  const args = { collectionId: c.id, name: 'Dark' };
  const plan = await result(h, 'create_variable_mode', args);
  assert.equal(plan.variableCount, 2); assert.equal(c.modes.length, 1); assert.equal(h.undoCount, 0);
  assert.match((await h.call('create_variable_mode', { ...args, dryRun: false })).error, /THEME_CHANGED/);
  const done = await result(h, 'create_variable_mode', { ...args, dryRun: false, revision: plan.revision });
  assert.equal(c.modes.length, 2); assert.equal(c.defaultModeId, 'mode:1');
  assert.deepEqual(a.valuesByMode[done.modeId], a.valuesByMode['mode:1']);
  assert.deepEqual(b.valuesByMode[done.modeId], { type: 'VARIABLE_ALIAS', id: a.id });
  assert.equal(h.undoCount, 1);
  assert.match((await h.call('create_variable_mode', args)).error, /already exists/);
});

test('mode preview is invalidated by changed values, modes or requested name', async () => {
  const { h, c, a } = fixture();
  const args = { collectionId: c.id, name: 'Dark' };
  const plan = await result(h, 'create_variable_mode', args);
  a.setValueForMode('mode:1', { r: 0, g: 0, b: 0 });
  assert.match((await h.call('create_variable_mode', { ...args, dryRun: false, revision: plan.revision })).error, /THEME_CHANGED/);
  const fresh = await result(h, 'create_variable_mode', args);
  assert.match((await h.call('create_variable_mode', { ...args, name: 'Another', dryRun: false, revision: fresh.revision })).error, /THEME_CHANGED/);
  assert.equal(c.modes.length, 1);
});

test('mode limits and failed writes leave original values untouched; failed cleanup stays explicit', async () => {
  const { h, c, b } = fixture();
  const args = { collectionId: c.id, name: 'Dark' };
  const plan = await result(h, 'create_variable_mode', args);
  const add = c.addMode;
  c.addMode = () => { throw new Error('Limited to 1 modes only'); };
  assert.match((await h.call('create_variable_mode', { ...args, dryRun: false, revision: plan.revision })).error, /Limited to 1/);
  c.addMode = add;
  b.setValueForMode = () => { throw new Error('Write failed'); };
  const error = (await h.call('create_variable_mode', { ...args, dryRun: false, revision: plan.revision })).error;
  assert.match(error, /New mode removed/); assert.equal(c.modes.length, 1);
  assert.deepEqual(Object.keys(b.valuesByMode), ['mode:1']);
  c.removeMode = () => { throw new Error('Cleanup failed'); };
  assert.match((await h.call('create_variable_mode', { ...args, dryRun: false, revision: plan.revision })).error, /Cleanup incomplete/);
  assert.equal(h.undoCount, 0);
});

test('remote/extended collections, incomplete values and oversized copies are refused before mutation', async () => {
  const { h, c, a } = fixture(), args = { collectionId: c.id, name: 'Dark' };
  c.remote = true; assert.match((await h.call('create_variable_mode', args)).error, /local, non-extended/); c.remote = false;
  c.isExtension = true; assert.match((await h.call('create_variable_mode', args)).error, /local, non-extended/); c.isExtension = false;
  delete a.valuesByMode['mode:1']; assert.match((await h.call('create_variable_mode', args)).error, /unavailable value/);
  a.valuesByMode['mode:1'] = 'x'.repeat(1024 * 1024);
  assert.match((await h.call('create_variable_mode', args)).error, /1 MiB/);
  assert.equal(c.modes.length, 1);
});

test('node mode preview, apply, inheritance and clear preserve other collection overrides', async () => {
  const { h, c } = fixture(), dark = c.addMode('Dark');
  const parent = modeNode(h, c), child = modeNode(h, c, parent);
  parent.explicitVariableModes.other = 'unrelated';
  const args = { collectionId: c.id, nodeId: parent.id, modeId: dark };
  const p = await result(h, 'set_variable_mode', args);
  assert.equal(p.dryRun, true); assert.equal(p.explicitModeId, null); assert.equal(h.undoCount, 0);
  assert.match((await h.call('set_variable_mode', { ...args, dryRun: false })).error, /THEME_CHANGED/);
  await result(h, 'set_variable_mode', { ...args, dryRun: false, revision: p.revision });
  const read = await result(h, 'get_variable_modes', { collectionId: c.id, nodeId: child.id });
  assert.equal(read.node.explicitModeId, null); assert.equal(read.node.resolvedModeId, dark);
  const clear = { ...args, modeId: null };
  const plan = await result(h, 'set_variable_mode', clear);
  await result(h, 'set_variable_mode', { ...clear, dryRun: false, revision: plan.revision });
  assert.equal(parent.explicitVariableModes.other, 'unrelated'); assert.equal(child.resolvedVariableModes[c.id], c.defaultModeId);
  assert.equal(h.undoCount, 2);
});

test('changed overrides invalidate mode preview and rejected setters restore previous state', async () => {
  const { h, c } = fixture(), dark = c.addMode('Dark'), n = modeNode(h, c);
  const args = { collectionId: c.id, nodeId: n.id, modeId: dark };
  const plan = await result(h, 'set_variable_mode', args);
  n.explicitVariableModes[c.id] = c.defaultModeId;
  assert.match((await h.call('set_variable_mode', { ...args, dryRun: false, revision: plan.revision })).error, /THEME_CHANGED/);
  delete n.explicitVariableModes[c.id];
  n.setExplicitVariableModeForCollection = (collection, mode) => { n.explicitVariableModes[c.id] = mode; throw new Error('Rejected'); };
  assert.match((await h.call('set_variable_mode', { ...args, dryRun: false, revision: plan.revision })).error, /Original override restored/);
  assert.equal(n.explicitVariableModes[c.id], undefined);
  assert.match((await h.call('set_variable_mode', { ...args, modeId: 'missing' })).error, /does not belong/);
  assert.equal(h.undoCount, 0);
});

test('local modes work without remote lookup and previews expire across plugin sessions', async () => {
  const first = fixture(), second = fixture();
  first.h.figma.variables.getVariableCollectionByIdAsync = async () => { throw new Error('Network unavailable'); };
  const args = { collectionId: first.c.id, name: 'Dark' };
  const plan = await result(first.h, 'create_variable_mode', args);
  assert.match((await second.h.call('create_variable_mode', { ...args, dryRun: false, revision: plan.revision })).error, /THEME_CHANGED/);
  assert.equal(second.c.modes.length, 1);
  assert.equal((await result(first.h, 'get_variable_modes', { collectionId: first.c.id })).collection.id, first.c.id);
});

test('copy preserves FLOAT/STRING/BOOLEAN values and refuses collections above the count budget', async () => {
  const { h, c } = fixture();
  const extra = [['FLOAT', 0], ['STRING', ''], ['BOOLEAN', false]].map(([type, value]) => {
    const v = h.figma.variables.createVariable(type, c, type); v.setValueForMode('mode:1', value); return v;
  });
  const args = { collectionId: c.id, name: 'Dark' }, plan = await result(h, 'create_variable_mode', args);
  const done = await result(h, 'create_variable_mode', { ...args, dryRun: false, revision: plan.revision });
  assert.deepEqual(extra.map(v => v.valuesByMode[done.modeId]), [0, '', false]);
  for (let i = 0; i < 1000; i++) h.figma.variables.createVariable(`extra-${i}`, c, 'FLOAT');
  assert.match((await h.call('create_variable_mode', { ...args, name: 'Extra' })).error, /at most 1000/);
  assert.equal(c.modes.length, 2);
});

test('inherited changes invalidate previews; no-op setters cannot report a successful mode change', async () => {
  const { h, c } = fixture(), dark = c.addMode('Dark'), parent = modeNode(h, c), child = modeNode(h, c, parent);
  const args = { collectionId: c.id, nodeId: child.id, modeId: dark }, plan = await result(h, 'set_variable_mode', args);
  parent.explicitVariableModes[c.id] = dark;
  assert.match((await h.call('set_variable_mode', { ...args, dryRun: false, revision: plan.revision })).error, /THEME_CHANGED/);
  const fresh = await result(h, 'set_variable_mode', args);
  child.setExplicitVariableModeForCollection = () => {};
  assert.match((await h.call('set_variable_mode', { ...args, dryRun: false, revision: fresh.revision })).error, /did not retain/);
  assert.equal(child.explicitVariableModes[c.id], undefined);
  assert.equal(h.undoCount, 0);
});
