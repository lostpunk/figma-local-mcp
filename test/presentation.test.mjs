import test from 'node:test';
import assert from 'node:assert/strict';
import { pluginHarness } from './plugin-harness.mjs';

function fixture() {
  const h = pluginHarness(), messages = [], sizes = [], moves = [], writes = [];
  h.figma.ui.postMessage = m => messages.push(m);
  h.figma.ui.resize = (w, h) => sizes.push([w, h]);
  h.figma.ui.reposition = (x, y) => moves.push([x, y]);
  h.figma.clientStorage.setAsync = async (key, value) => writes.push({ key, value });
  const send = m => h.figma.ui.onmessage(m);
  return { ...h, messages, sizes, moves, writes, send };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
test('failed window resize reports the actual mode, never saves it and allows a later retry', async () => {
  const h = fixture();
  h.figma.ui.resize = () => { throw new Error('Window resize failed'); };
  await assert.doesNotReject(h.send({ type: 'presentation-mode', compact: false }));
  await flush();
  assert.equal(h.writes.length, 0);
  assert.equal(h.messages.find(m => m.type === 'presentation-state').compact, true);
  assert.equal(h.messages.at(-1).type, 'presentation-error');
  h.figma.ui.resize = (w, height) => h.sizes.push([w, height]);
  await h.send({ type: 'presentation-mode', compact: false }); await flush();
  assert.deepEqual(h.sizes, [[380, 640]]);
  assert.equal(h.writes[0].value.compact, false);
});
test('failure restoring an expanded window keeps compact mode and identifies resize rather than storage', async () => {
  const h = fixture();
  h.figma.clientStorage.getAsync = async () => ({ version: 1, compact: false });
  h.figma.ui.resize = () => { throw new Error('Window resize failed'); };
  await h.send({ type: 'init' });
  assert.equal(h.messages.find(m => m.type === 'presentation-state')?.compact, true);
  assert.match(h.messages.at(-1).error, /размер/);
});
test('window mode restores from local preferences and does not change the document', async () => {
  const h = fixture();
  h.figma.clientStorage.getAsync = async () => ({ version: 1, compact: false });
  await h.send({ type: 'init' });
  assert.deepEqual(h.sizes, [[380, 640]]);
  await h.send({ type: 'presentation-mode', compact: true });
  await flush();
  assert.deepEqual(h.sizes.at(-1), [300, 64]);
  assert.equal(h.writes[0].value.compact, true);
  assert.equal(h.undoCount, 0); assert.equal(h.page.children.length, 0);
  assert.equal(h.messages.at(-1).type, 'presentation-state');
  await h.send({ type: 'init' });
  assert.equal(h.sizes.length, 2, 'metadata refresh must not restore stale preferences');
});
test('a user mode change wins over a pending preference read; rapid saves stay in order', async () => {
  const h = fixture(); let read, save;
  h.figma.clientStorage.getAsync = () => new Promise(resolve => { read = resolve; });
  h.figma.clientStorage.setAsync = async (_key, value) => {
    h.writes.push(value.compact);
    if (h.writes.length === 1) await new Promise(resolve => { save = resolve; });
  };
  const init = h.send({ type: 'init' });
  await h.send({ type: 'presentation-mode', compact: false });
  await h.send({ type: 'presentation-mode', compact: true });
  read({ version: 1, compact: false }); await init;
  assert.deepEqual(h.sizes, [[380, 640], [300, 64]]);
  assert.deepEqual(h.writes, [false]);
  save(); await flush(); assert.deepEqual(h.writes, [false, true]);
});
test('malformed preferences/messages and unavailable storage cannot trigger arbitrary window sizes', async () => {
  const h = fixture();
  h.figma.clientStorage.getAsync = async () => ({ version: 99, compact: false });
  await h.send({ type: 'init' });
  assert.deepEqual(h.sizes, [[300, 64]]);
  await h.send({ type: 'presentation-mode', compact: 'false', width: 9000 });
  assert.equal(h.sizes.length, 1);
  h.figma.clientStorage.setAsync = async () => { throw new Error('No storage'); };
  await h.send({ type: 'presentation-mode', compact: false }); await flush();
  assert.equal(h.messages.at(-1).type, 'presentation-error');
  h.figma.clientStorage.setAsync = async () => {};
  await h.send({ type: 'presentation-mode', compact: true }); await flush();
  assert.deepEqual(h.sizes.at(-1), [300, 64]);
});
test('edge placement accounts for canvas zoom, validates the edge and falls back on API errors', async () => {
  const h = fixture();
  Object.assign(h.figma.viewport, { bounds: { x: 100, y: 200, width: 1000, height: 600 }, zoom: 2 });
  await h.send({ type: 'presentation-move', edge: 'right' });
  await h.send({ type: 'presentation-move', edge: 'left' });
  assert.deepEqual(h.moves, [[944, 206], [106, 206]]);
  await h.send({ type: 'presentation-move', edge: 'other' }); assert.equal(h.moves.length, 2);
  h.figma.viewport.zoom = 0;
  await h.send({ type: 'presentation-move', edge: 'right' });
  assert.equal(h.messages.at(-1).type, 'presentation-error'); assert.equal(h.moves.length, 2);
});
test('window controls remain available during a document operation without replaying it', async () => {
  const h = fixture(); let release;
  const lookup = h.figma.getNodeByIdAsync;
  h.figma.getNodeByIdAsync = async id => { await new Promise(resolve => { release = resolve; }); return lookup(id); };
  const pending = h.send({ type: 'command', id: 'read', command: 'get_node', args: { nodeId: h.page.id } });
  await h.send({ type: 'presentation-mode', compact: false });
  assert.deepEqual(h.sizes, [[380, 640]]);
  release(); await pending;
  assert.equal(h.messages.filter(m => m.type === 'result' && m.id === 'read').length, 1);
});
