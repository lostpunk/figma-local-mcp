import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, cp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createSharedWorker, connectSharedBridge, openSharedBridge } from '../src/shared-bridge.mjs';
import { VERSION } from '../src/readiness.mjs';
const token = 'd'.repeat(64);
const data = response => JSON.parse(response.content[0].text);
async function plugin(port, t) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`, { origin: 'null' });
  t.after(() => socket.terminate());
  await once(socket, 'open'); const ready = once(socket, 'message');
  socket.send(JSON.stringify({ type: 'hello', token, pluginSessionId: 'test-plugin', document: { pluginVersion: VERSION } }));
  await ready; return socket;
}
async function fixture(t, idleMs = 3000) {
  const worker = await createSharedWorker({ port: 0, installationToken: token, idleMs });
  t.after(() => worker.close());
  const options = { port: worker.info().port, installationToken: token, timeoutMs: 1000 };
  const clients = await Promise.all([connectSharedBridge(options), connectSharedBridge(options)]);
  for (const client of clients) t.after(() => client.close());
  return { worker, clients, options, socket: await plugin(options.port, t) };
}

test('shared clients serialize writes, reject ID collisions and retain one plugin when a client exits', async t => {
  const { worker, clients: [a,b], socket } = await fixture(t, 500);
  let dispatches = 0;
  socket.on('message', raw => {
    const message = JSON.parse(raw); if (message.type !== 'command') return;
    dispatches++;
    setTimeout(() => socket.send(JSON.stringify({ type: 'result', id: message.id, result: { ok: true } })), 30);
  });
  const ai = await a.info(VERSION), bi = await b.info(VERSION);
  assert.equal(ai.serverSessionId, bi.serverSessionId); assert.equal(ai.clientCount, 2);
  const options = { operationId: ai.nextOperationId, write: true, skillVersion: VERSION };
  const dispatched = once(socket, 'message');
  const first = a.request('create_node', { type: 'RECTANGLE' }, options);
  await dispatched;
  await assert.rejects(b.request('create_node', { type: 'RECTANGLE' }, options), /another MCP client/);
  assert.deepEqual(await first, { ok: true });
  assert.deepEqual(await a.request('create_node', { type: 'RECTANGLE' }, options), { ok: true });
  assert.equal(dispatches, 1);
  assert.equal((await b.getOperation(options.operationId)).status, 'completed');
  assert.equal((await b.listOperations({ limit: 1 })).entries[0].operationId, options.operationId);
  await a.close();
  assert.deepEqual(await b.request('get_document', {}), { ok: true });
  assert.equal(worker.info().clientCount, 1);
  const closed = once(socket, 'close'); await b.close(); await closed;
});

test('shared bridge rejects wrong keys and browser origins without disconnecting the plugin', async t => {
  const { clients: [a], options, socket } = await fixture(t);
  await assert.rejects(connectSharedBridge({ ...options, installationToken: 'e'.repeat(64) }), /authentication/);
  const browser = new WebSocket(`ws://127.0.0.1:${options.port}/mcp-bridge`, { origin: 'null' });
  t.after(() => browser.terminate());
  const [code] = await once(browser, 'close'); assert.equal(code, 1008);
  assert.equal((await a.info(VERSION)).connected, true); assert.equal(socket.readyState, WebSocket.OPEN);
});

test('rejected clients do not postpone shutdown after the last authenticated client exits', { timeout: 5000 }, async t => {
  const { worker, clients, options, socket } = await fixture(t, 250);
  let rejected = 0, stopped = false;
  const closed = once(socket, 'close').then(() => { stopped = true; });
  await Promise.all(clients.map(client => client.close()));
  for (let attempt = 0; attempt < 15 && !stopped; attempt++) {
    await connectSharedBridge({ ...options, installationToken: 'e'.repeat(64) }).then(
      client => client.close(), () => { rejected++; });
    await delay(40);
  }
  assert.ok(rejected >= 1);
  assert.equal(stopped, true, 'rejections must not extend the idle deadline');
  await closed;
});

test('a foreign service never receives the installation key or RPC commands', async t => {
  const fake = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(fake, 'listening');
  t.after(() => new Promise(resolve => fake.close(resolve)));
  const received = [];
  fake.on('connection', socket => {
    socket.send(JSON.stringify({ type: 'challenge', protocol: 'figma-local-bridge-v1', version: VERSION, nonce: 'a'.repeat(64) }));
    socket.on('message', raw => { received.push(raw.toString()); socket.send(JSON.stringify({ type: 'authenticated', proof: 'b'.repeat(64) })); });
  });
  await assert.rejects(connectSharedBridge({ port: fake.address().port, installationToken: token }), /unauthenticated/);
  assert.equal(received.length, 1); assert.ok(!received[0].includes(token)); assert.equal(JSON.parse(received[0]).type, 'authenticate');
});

test('an older worker is rejected before authentication or document access', async t => {
  const fake = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(fake, 'listening');
  t.after(() => new Promise(resolve => fake.close(resolve)));
  let messages = 0;
  fake.on('connection', socket => {
    socket.on('message', () => messages++);
    socket.send(JSON.stringify({ type: 'challenge', protocol: 'figma-local-bridge-v1', version: '0.0.0', nonce: 'a'.repeat(64) }));
  });
  await assert.rejects(connectSharedBridge({ port: fake.address().port, installationToken: token }), error => error.code === 'BRIDGE_VERSION_MISMATCH');
  assert.equal(messages, 0);
});

test('a worker disconnect fails an in-flight edit without replaying it', async t => {
  const { worker, clients: [a], socket } = await fixture(t);
  const info = await a.info(VERSION), dispatched = once(socket, 'message');
  const request = a.request('create_node', {}, { operationId: info.nextOperationId, write: true, skillVersion: VERSION });
  const rejected = assert.rejects(request, /disconnected/);
  await dispatched; await worker.close(); await rejected;
});

test('several portable MCP processes share a worker and survive the first client closing', { timeout: 20000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'figma-shared-mcp-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'runtime')); await mkdir(join(directory, 'generated'));
  await cp(new URL('../runtime/server.mjs', import.meta.url), join(directory, 'runtime/server.mjs'));
  await writeFile(join(directory, 'generated/pairing-key.json'), JSON.stringify({ token }));
  const probe = createServer().listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const clients = await Promise.all(Array.from({ length: 3 }, async () => {
    const client = new Client({ name: 'shared-integration', version: '1.0' });
    t.after(() => client.close());
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(directory, 'runtime/server.mjs')],
      env: { ...process.env, FIGMA_BRIDGE_PORT: String(port) }, stderr: 'pipe' }));
    return client;
  }));
  const socket = await plugin(port, t);
  socket.on('message', raw => {
    const message = JSON.parse(raw);
    if (message.type === 'command') socket.send(JSON.stringify({ type: 'result', id: message.id, result: { name: 'Test file' } }));
  });
  const connections = await Promise.all(clients.map(client => client.callTool({ name: 'get_connection', arguments: { skillVersion: VERSION } }).then(data)));
  assert.equal(new Set(connections.map(c => c.serverSessionId)).size, 1);
  assert.ok(connections.every(c => c.readiness.ready && c.transport === 'shared' && c.clientCount === 3));
  await clients[0].close();
  assert.equal(data(await clients[1].callTool({ name: 'get_document', arguments: {} })).name, 'Test file');
  const events = (await readFile(join(directory, 'generated/logs/events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(events.filter(e => e.event === 'bridge_started').length, 1);
  assert.equal(events.filter(e => e.event === 'server_start_failed').length, 0);
  const closed = once(socket, 'close'); await clients[1].close(); await clients[2].close(); await closed;
});

test('new client leaves a legacy worker idle long enough to exit before starting the new version', { timeout: 20000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'figma-legacy-upgrade-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'runtime')); await mkdir(join(directory, 'generated'));
  await cp(new URL('../runtime/server.mjs', import.meta.url), join(directory, 'runtime/server.mjs'));
  await writeFile(join(directory, 'generated/pairing-key.json'), JSON.stringify({ token }));
  const legacy = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(legacy, 'listening');
  const port = legacy.address().port;
  let timer, attempts = 0;
  const arm = () => { clearTimeout(timer); timer = setTimeout(() => legacy.close(), 3000); };
  legacy.on('connection', socket => {
    attempts++;
    socket.on('close', arm); // Reproduce 0.7.15's reset for rejected connections.
    socket.send(JSON.stringify({ type: 'challenge', protocol: 'figma-local-bridge-v1', version: '0.0.0', nonce: 'a'.repeat(64) }));
  });
  arm();
  t.after(() => { clearTimeout(timer); for (const socket of legacy.clients) socket.terminate(); legacy.close(); });
  const client = await openSharedBridge({ port, installationToken: token, timeoutMs: 120000, entry: join(directory, 'runtime/server.mjs') });
  t.after(() => client.close());
  assert.equal(attempts, 1, 'version retries must not keep a legacy worker alive');
  assert.equal((await client.info(VERSION)).transport, 'shared');
  // Observe normal worker shutdown before deleting the isolated installation.
  const observer = new WebSocket(`ws://127.0.0.1:${port}`); await once(observer, 'open');
  const closed = once(observer, 'close'); t.after(() => observer.terminate());
  await client.close(); await closed;
});
