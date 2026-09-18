import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, stat, symlink, readdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createOperationHistory, historyRetention } from '../src/operation-history.mjs';
import { createOperations } from '../src/operations.mjs';
import { createBridge } from '../src/bridge.mjs';

const token = 'a'.repeat(64);
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'figma-history-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, store: options => createOperationHistory({ directory, port: 3055, installationToken: token, ...options }) };
}
test('encrypted bounded results survive restart; arguments are not stored or automatically replayed', async t => {
  const f = await fixture(t); let ops = createOperations({ history: f.store() });
  const id = ops.nextId(); ops.start(id, 'create_node', { privateArgs: 'secret-args' }, 'plugin-session');
  ops.finish(id, { result: { id: '1:2', name: 'private-result' } });
  const disk = await readFile(join(f.directory, 'port-3055.enc'), 'utf8');
  assert.ok(!disk.includes('private-result')); assert.ok(!disk.includes('secret-args')); assert.ok(!disk.includes(token));
  ops = createOperations({ history: f.store() });
  assert.equal(ops.view(id).historical, true); assert.deepEqual(ops.view(id).result, { id: '1:2', name: 'private-result' });
  assert.notEqual(ops.nextId().split(':')[0], id.split(':')[0]);
  assert.throws(() => ops.start(id, 'create_node', {}), /nextOperationId/);
  assert.equal(ops.existing(id, 'create_node', { privateArgs: 'secret-args' }).status, 'completed');
  assert.ok(!JSON.stringify(ops.list()).includes('private-result'));
  if (process.platform !== 'win32') assert.equal((await stat(join(f.directory, 'port-3055.enc'))).mode & 0o777, 0o600);
});
test('unfinished writes restore as unknown, failures stay failed, and oversized results expire', async t => {
  const f = await fixture(t); let ops = createOperations({ history: f.store() });
  const unfinished = ops.nextId(); ops.start(unfinished, 'create_scene', {}, 'old-plugin');
  const failed = ops.nextId(); ops.start(failed, 'update_node', {}); ops.finish(failed, { error: 'failed safely' });
  const large = ops.nextId(); ops.start(large, 'create_scene', {}); ops.finish(large, { result: 'x'.repeat(historyRetention.maxResultBytes + 1) });
  ops = createOperations({ history: f.store() });
  assert.equal(ops.view(unfinished).status, 'unknown'); assert.equal(ops.view(failed).status, 'failed');
  assert.equal(ops.view(large).resultExpired, true); assert.equal(ops.view(large).status, 'completed');
});
test('age and count retention never recycle operation IDs', async t => {
  const f = await fixture(t); const ops = createOperations({ history: f.store() }); const old = ops.nextId();
  for (let i = 0; i < 102; i++) { const id = ops.nextId(); ops.start(id, 'update_node', { i }); ops.finish(id, { result: { i } }); }
  const restored = createOperations({ history: f.store() }); assert.equal(restored.list({ limit: 100 }).entries.length, 100);
  assert.throws(() => restored.existing(old, 'update_node', { i: 0 }), /another server session/);
  assert.equal(f.store({ now: () => Date.now() + historyRetention.maxAgeMs + 1 }).load().length, 0);
});
test('corruption, wrong keys and future formats fail closed without replacing evidence', async t => {
  const f = await fixture(t); const ops = createOperations({ history: f.store() }); const id = ops.nextId(); ops.start(id, 'create_node', {});
  const file = join(f.directory, 'port-3055.enc'); const original = await readFile(file, 'utf8');
  assert.throws(() => createOperations({ history: f.store({ installationToken: 'b'.repeat(64) }) }), /decrypt or validate/);
  assert.equal(await readFile(file, 'utf8'), original);
  const envelope = JSON.parse(original); envelope.format = 2; await writeFile(file, JSON.stringify(envelope));
  assert.throws(() => createOperations({ history: f.store() }), /Unsupported/);
  await writeFile(file, '{broken'); assert.throws(() => createOperations({ history: f.store() }));
  assert.equal(await readFile(file, 'utf8'), '{broken');
});
test('history storage errors stop future writes, while the known in-memory outcome remains readable', () => {
  let broken = false;
  const ops = createOperations({ history: { load: () => [], save() { if (broken) throw new Error('Disk full'); } } });
  const id = ops.nextId(); ops.start(id, 'update_node', {}); broken = true;
  assert.equal(ops.finish(id, { result: { ok: true } }), false);
  assert.equal(ops.info().healthy, false); assert.deepEqual(ops.view(id).result, { ok: true });
  assert.throws(() => ops.start(ops.nextId(), 'create_node', {}), /history is unavailable/);
});
test('clock correction cannot make a saved history unreadable, and invalid commands never enter it', async t => {
  const f = await fixture(t); let time = Date.now(); const now = () => time;
  const ops = createOperations({ history: f.store({ now }), now });
  assert.throws(() => ops.start(ops.nextId(), 'invalid.command', {}), /Invalid operation command/);
  const id = ops.nextId(); ops.start(id, 'update_node', {}); time -= 10000;
  ops.finish(id, { result: { ok: true } });
  const restored = createOperations({ history: f.store({ now }), now });
  assert.equal(restored.view(id).status, 'completed'); assert.equal(restored.view(id).elapsedMs, 0);
});
test('history refuses symlinked files and directories', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t); const victim = join(f.directory, 'victim'); await writeFile(victim, 'keep');
  await symlink(victim, join(f.directory, 'port-3055.enc'));
  assert.throws(() => createOperations({ history: f.store() }), /Invalid operation history/);
  assert.equal(await readFile(victim, 'utf8'), 'keep');
  const alias = join(f.directory, 'alias'); await symlink(f.directory, alias);
  assert.throws(() => f.store({ directory: alias }), /symlink/);
});
async function pair(bridge, pluginSessionId) {
  const socket = new WebSocket(`ws://127.0.0.1:${bridge.info().port}`);
  await once(socket, 'open'); const ready = once(socket, 'message');
  socket.send(JSON.stringify({ type: 'hello', token, pluginSessionId })); await ready; return socket;
}
test('disk failure before dispatch blocks the edit; failure after completion retains readable outcome', async t => {
  for (const phase of ['start', 'finish']) {
    const f = await fixture(t); const storage = join(f.directory, 'store');
    const bridge = await createBridge({ port: 0, installationToken: token, historyDirectory: storage });
    t.after(() => bridge.close()); const socket = await pair(bridge, 'test-session');
    let dispatches = 0; socket.on('message', raw => { if (JSON.parse(raw).type === 'command') dispatches++; });
    const breakStorage = async () => { await rename(storage, storage + '-saved'); await writeFile(storage, 'not a directory'); };
    const id = bridge.info().nextOperationId;
    if (phase === 'start') {
      await breakStorage();
      await assert.rejects(bridge.request('create_node', {}, { operationId: id, write: true }), /Cannot persist/);
      assert.equal(dispatches, 0);
      assert.equal(bridge.getOperation(id).status, 'failed');
      assert.match(bridge.getOperation(id).error, /not dispatched/);
    } else {
      const received = once(socket, 'message'); const result = bridge.request('create_node', {}, { operationId: id, write: true });
      await received; await breakStorage(); socket.send(JSON.stringify({ type: 'result', id, result: { id: 'done' } }));
      assert.deepEqual(await result, { id: 'done' }); assert.equal(bridge.getOperation(id).status, 'completed');
    }
    assert.equal(bridge.info().history.healthy, false);
    assert.ok(bridge.info().readiness.issues.some(issue => issue.code === 'HISTORY_WRITE_FAILED'));
    await assert.rejects(bridge.request('create_node', {}, { operationId: bridge.info().nextOperationId, write: true }), /history is unavailable/);
  }
});
test('real bridge restart recovers a late result only from its original plugin, without dispatching writes', async t => {
  const f = await fixture(t);
  let bridge = await createBridge({ port: 0, installationToken: token, historyDirectory: f.directory });
  t.after(() => bridge.close());
  const port = bridge.info().port;
  let socket = await pair(bridge, 'original'); const id = bridge.info().nextOperationId;
  const received = once(socket, 'message'); const result = bridge.request('create_node', {}, { write: true, operationId: id });
  const rejected = assert.rejects(result, /shutting down/); await received; await bridge.close(); await rejected;
  bridge = await createBridge({ port, installationToken: token, historyDirectory: f.directory });
  assert.equal(bridge.getOperation(id).status, 'unknown');
  socket = await pair(bridge, 'other');
  socket.send(JSON.stringify({ type: 'recovered_result', id, result: { wrong: true } }));
  // A normal read response is an ordering barrier, not a timing-dependent sleep.
  const readCommand = once(socket, 'message'); const read = bridge.request('get_document', {});
  const command = JSON.parse((await readCommand)[0]); socket.send(JSON.stringify({ type: 'result', id: command.id, result: {} })); await read;
  assert.equal(bridge.getOperation(id).status, 'unknown');
  const closed = once(socket, 'close'); socket.close(); await closed;
  socket = await pair(bridge, 'original'); const ack = once(socket, 'message');
  socket.send(JSON.stringify({ type: 'recovered_result', id, result: { id: 'recovered-layer' } }));
  assert.equal(JSON.parse((await ack)[0]).type, 'result_ack');
  assert.deepEqual(bridge.getOperation(id).result, { id: 'recovered-layer' });
  let writes = 0; socket.on('message', raw => { if (JSON.parse(raw).type === 'command') writes++; });
  assert.deepEqual(await bridge.request('create_node', {}, { write: true, operationId: id }), { id: 'recovered-layer' });
  assert.equal(writes, 0);
  await bridge.close(); bridge = await createBridge({ port, installationToken: token, historyDirectory: f.directory });
  assert.equal(bridge.listOperations({ limit: 1 }).entries[0].status, 'completed');
  assert.equal((await readdir(f.directory)).some(name => name.endsWith('.tmp')), false);
});
