import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createBridge } from '../src/bridge.mjs';

async function pair(bridge, token = bridge.info().pairingCode) {
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
  for (let i = 0; i < 2; i++) {
    const bridge = await createBridge({ port: 0, installationToken });
    try {
      assert.equal(bridge.info().pairingMode, 'automatic');
      assert.equal(bridge.info().pairingCode, undefined);
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

test('timeout keeps the paired session and waits for the late plugin result', async t => {
  const bridge = await createBridge({ port: 0, timeoutMs: 30 });
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
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(bridge.info().operation, 'idle');
  const nextMessage = once(socket, 'message');
  const next = bridge.request('get_document', {});
  const nextCommand = JSON.parse((await nextMessage)[0]);
  socket.send(JSON.stringify({ type: 'result', id: nextCommand.id, result: { name: 'Test' } }));
  assert.deepEqual(await next, { name: 'Test' });
});

test('second plugin cannot displace current session', async t => {
  const bridge = await createBridge({ port: 0 });
  t.after(() => bridge.close());
  await pair(bridge);
  const socket = new WebSocket(`ws://127.0.0.1:${bridge.info().port}`);
  const closed = once(socket, 'close');
  await once(socket, 'open');
  socket.send(JSON.stringify({ type: 'hello', token: bridge.info().pairingCode }));
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
