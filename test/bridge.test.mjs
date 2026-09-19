import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createBridge as createBridgeImpl } from '../src/bridge.mjs';
const testToken = 'a'.repeat(64);
const createBridge = options => createBridgeImpl({ installationToken: testToken, ...options });

async function pair(bridge, token = testToken) {
  const socket = new WebSocket(`ws://127.0.0.1:${bridge.info().port}`, { origin: 'null' });
  await once(socket, 'open');
  const ready = once(socket, 'message');
  socket.send(JSON.stringify({ type: 'hello', token, document: { name: 'Test' } }));
  await ready;
  return socket;
}
test('installation key survives bridge restarts and still requires authentication', async t => {
  const installationToken = 'b'.repeat(64);
  await assert.rejects(createBridge({ port: 0, installationToken: '' }), /Invalid installation token/);
  await assert.rejects(createBridgeImpl({ port: 0 }), /Run scripts\/setup/);
  for (let i = 0; i < 2; i++) {
    const bridge = await createBridge({ port: 0, installationToken });
    try {
      assert.equal(bridge.info().pairingMode, 'automatic');
      assert.equal(bridge.info().pairingCode, undefined);
      assert.ok(!JSON.stringify(bridge.info()).includes(installationToken));
      await pair(bridge, installationToken);
      assert.equal(bridge.info().connected, true);
    } finally { await bridge.close(); }
  }
});
test('bridge requires pairing and rejects untrusted origins', async t => {
  const bridge = await createBridge({ port: 0 });
  t.after(() => bridge.close());
  await assert.rejects(bridge.request('get_document', {}), /not connected/);
  for (const origin of ['null', 'https://evil.example']) {
    const socket = new WebSocket(`ws://127.0.0.1:${bridge.info().port}`, { origin });
    const closed = once(socket, 'close');
    await once(socket, 'open');
    socket.send(JSON.stringify({ type: 'hello', token: 'wrong' }));
    assert.equal((await closed)[0], 1008);
  }
  assert.equal(bridge.info().connected, false);
});

test('bridge correlates responses and rejects overlapping requests', async t => {
  const bridge = await createBridge({ port: 0 });
  t.after(() => bridge.close());
  const socket = await pair(bridge);
  const received = once(socket, 'message');
  const response = bridge.request('get_node', { nodeId: '1:2' });
  const command = JSON.parse((await received)[0]);
  await assert.rejects(bridge.request('get_document', {}), /operation is running/);
  socket.send(JSON.stringify({ type: 'result', id: 'wrong-id', result: { wrong: true } }));
  socket.send(JSON.stringify({ type: 'result', id: command.id, result: { id: '1:2' } }));
  assert.deepEqual(await response, { id: '1:2' });
});

test('timeout keeps the paired session and waits for the late plugin result', { timeout: 3000 }, async t => {
  const events = [];
  const lateReceived = Promise.withResolvers();
  const bridge = await createBridge({ port: 0, timeoutMs: 30, diagnostics: { record: (level, event, fields) => { events.push({ level, event, ...fields }); if (event === 'plugin_late_result') lateReceived.resolve(); } } });
  t.after(() => bridge.close());
  const socket = await pair(bridge);
  const received = once(socket, 'message');
  const response = bridge.request('update_node', {});
  const command = JSON.parse((await received)[0]);
  await assert.rejects(response, /plugin remains connected/);
  assert.equal(bridge.info().connected, true);
  assert.equal(bridge.info().operation, 'timed_out_waiting_result');
  await assert.rejects(bridge.request('get_document', {}), /previous Figma operation timed out/);
  socket.send(JSON.stringify({ type: 'result', id: command.id, result: { completed: true } }));
  await lateReceived.promise;
  assert.equal(bridge.info().operation, 'idle');
  const nextMessage = once(socket, 'message');
  const next = bridge.request('get_document', {});
  const nextCommand = JSON.parse((await nextMessage)[0]);
  socket.send(JSON.stringify({ type: 'result', id: nextCommand.id, result: { name: 'Test' } }));
  assert.deepEqual(await next, { name: 'Test' });
  const failed = events.find(e => e.code === 'TIMEOUT');
  const late = events.find(e => e.event === 'plugin_late_result');
  assert.equal(failed.requestId, command.id);
  assert.equal(late.requestId, command.id);
  assert.equal(late.command, 'update_node');
  assert.equal(late.outcome, 'plugin_completed');
  assert.ok(late.durationMs >= failed.durationMs);
});

test('second plugin cannot displace current session', async t => {
  const bridge = await createBridge({ port: 0 });
  t.after(() => bridge.close());
  await pair(bridge);
  const socket = new WebSocket(`ws://127.0.0.1:${bridge.info().port}`);
  const closed = once(socket, 'close');
  await once(socket, 'open');
  socket.send(JSON.stringify({ type: 'hello', token: testToken }));
  assert.equal((await closed)[0], 1008);
  assert.equal(bridge.info().connected, true);
});

test('authenticated document updates refresh connection metadata', async t => {
  const bridge = await createBridge({ port: 0 });
  t.after(() => bridge.close());
  const socket = await pair(bridge);
  const received = once(socket, 'message');
  const response = bridge.request('get_document', {});
  const command = JSON.parse((await received)[0]);
  socket.send(JSON.stringify({ type: 'document', document: { name: 'Updated', page: 'Screens', capabilities: { pageCount: 3 } } }));
  socket.send(JSON.stringify({ type: 'result', id: command.id, result: {} }));
  await response;
  assert.equal(bridge.info().document.page, 'Screens');
  assert.equal(bridge.info().document.capabilities.pageCount, 3);
});

test('same write ID is dispatched once and late results are recoverable', { timeout: 3000 }, async t => {
  const done = Promise.withResolvers();
  const bridge = await createBridge({ port: 0, timeoutMs: 40, diagnostics: { record: (_l, e) => { if (e === 'plugin_late_result') done.resolve(); } } });
  t.after(() => bridge.close());
  const socket = await pair(bridge);
  let dispatched = 0; socket.on('message', raw => { if (JSON.parse(raw).type === 'command') dispatched++; });
  const operationId = bridge.info().nextOperationId;
  const received = once(socket, 'message');
  const response = bridge.request('create_node', { name: 'A' }, { write: true, operationId });
  await received;
  await assert.rejects(bridge.request('create_node', { name: 'A' }, { write: true, operationId }), /not replayed/);
  await assert.rejects(response, /timed out/);
  assert.equal(bridge.getOperation(operationId).status, 'waiting_result');
  await assert.rejects(bridge.request('create_node', { name: 'B' }, { write: true, operationId }), /different arguments/);
  socket.send(JSON.stringify({ type: 'result', id: operationId, result: { id: '2:3' } }));
  await done.promise;
  assert.deepEqual(bridge.getOperation(operationId).result, { id: '2:3' });
  assert.deepEqual(await bridge.request('create_node', { name: 'A' }, { write: true, operationId }), { id: '2:3' });
  assert.equal(dispatched, 1);
});

test('lost write stays unknown and only its original plugin session can recover it', async t => {
  const events = [];
  const bridge = await createBridge({ port: 0, diagnostics: { record: (_l, e) => events.push(e) } });
  t.after(() => bridge.close());
  async function connect(pluginSessionId) {
    const s = new WebSocket(`ws://127.0.0.1:${bridge.info().port}`);
    await once(s, 'open'); const ready = once(s, 'message');
    s.send(JSON.stringify({ type: 'hello', token: testToken, pluginSessionId })); await ready; return s;
  }
  const s = await connect('original');
  const operationId = bridge.info().nextOperationId;
  const received = once(s, 'message');
  const response = bridge.request('create_node', {}, { write: true, operationId });
  const rejected = assert.rejects(response, /disconnected/);
  await received; s.close(); await rejected;
  assert.equal(bridge.getOperation(operationId).status, 'unknown');
  const other = await connect('other');
  other.send(JSON.stringify({ type: 'recovered_result', id: operationId, result: { fake: true } }));
  // A following normal read response gives a deterministic ordering barrier.
  async function barrier(s) {
    const incoming = once(s, 'message'); const result = bridge.request('get_document', {});
    const msg = JSON.parse((await incoming)[0]); s.send(JSON.stringify({ type: 'result', id: msg.id, result: {} })); await result;
  }
  await barrier(other);
  assert.equal(bridge.getOperation(operationId).status, 'unknown');
  const closed = once(other, 'close'); other.close(); await closed;
  const original = await connect('original');
  original.send(JSON.stringify({ type: 'recovered_result', id: operationId, result: { id: '3:4' } }));
  await barrier(original);
  assert.deepEqual(bridge.getOperation(operationId).result, { id: '3:4' });
  assert.ok(events.includes('operation_recovered'));
});

test('large plugin reads fit the transport and leave the connection usable', async t => {
  const { pluginHarness } = await import('./plugin-harness.mjs');
  const h = pluginHarness();
  const frame = h.node('FRAME', 'Large', h.page);
  for (let i = 0; i < 900; i++) h.node('TEXT', String(i), frame).characters = 'я'.repeat(10000);
  const bridge = await createBridge({ port: 0 });
  t.after(() => bridge.close());
  const socket = await pair(bridge);
  socket.on('message', async raw => {
    const command = JSON.parse(raw);
    if (command.type !== 'command') return;
    const response = await h.call(command.command, command.args);
    socket.send(JSON.stringify({ ...response, id: command.id }));
  });
  const result = await bridge.request('get_node', { nodeId: frame.id, depth: 1, maxNodes: 1000 });
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 1024 * 1024);
  assert.equal(result.childrenTruncated, true);
  assert.equal(bridge.info().connected, true);
  assert.equal((await bridge.request('get_document', {})).name, 'Test file');
});
