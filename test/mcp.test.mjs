import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { WebSocket } from 'ws';
import { pluginHarness } from './plugin-harness.mjs';
import { mkdtemp, cp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

for (const bundled of [false, true]) test(`MCP → WebSocket → plugin: full workflow (${bundled ? 'portable bundle without node_modules' : 'source'})`, async t => {
  let entry = fileURLToPath(new URL('../src/server.mjs', import.meta.url));
  if (bundled) {
    const directory = await mkdtemp(join(tmpdir(), 'figma portable $ space-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    await mkdir(join(directory, 'runtime'));
    await mkdir(join(directory, 'generated'));
    await writeFile(join(directory, 'generated/pairing-key.json'), JSON.stringify({ token: 'c'.repeat(64) }));
    entry = join(directory, 'runtime/server.mjs');
    await cp(new URL('../runtime/server.mjs', import.meta.url), entry);
  }
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [entry],
    env: { ...process.env, FIGMA_BRIDGE_PORT: '0' }, stderr: 'pipe' });
  const client = new Client({ name: 'test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(transport);
  const call = (name, args = {}) => client.callTool({ name, arguments: args });
  const data = result => JSON.parse(result.content[0].text);
  const listed = await client.listTools();
  assert.equal(listed.tools.length, 29);
  assert.equal(listed.tools.find(t => t.name === 'move_component').annotations.readOnlyHint, false);
  assert.equal(listed.tools.find(t => t.name === 'delete_node').annotations.destructiveHint, true);
  assert.equal((await call('get_document')).isError, true);
  const diagnostic = data(await call('get_diagnostics', { errorsOnly: true, limit: 10 }));
  assert.ok(diagnostic.entries.some(e => e.command === 'get_document' && e.level === 'error'));
  assert.match(diagnostic.logFile, /events\.jsonl$/);
  const connection = data(await call('get_connection'));
  if (bundled) {
    assert.equal(connection.pairingMode, 'automatic');
    assert.equal(connection.pairingCode, undefined);
  }
  const manifest = JSON.parse(await readFile(new URL('../plugin/manifest.json', import.meta.url), 'utf8'));
  const endpoint = new URL(manifest.networkAccess.devAllowedDomains[0]);
  const ui = await readFile(new URL('../plugin/ui.html', import.meta.url), 'utf8');
  const uiEndpoint = ui.match(/new WebSocket\('([^']+)'\)/)?.[1];
  assert.equal(new URL(uiEndpoint).href, endpoint.href, 'plugin connects to the manifest endpoint');
  endpoint.port = String(connection.port);
  const socket = new WebSocket(endpoint, { origin: 'null' });
  t.after(() => socket.terminate());
  await once(socket, 'open');
  const ready = once(socket, 'message');
  socket.send(JSON.stringify({ type: 'hello', token: bundled ? 'c'.repeat(64) : connection.pairingCode }));
  await ready;
  const h = pluginHarness();
  let dispatchCount = 0;
  socket.on('message', async raw => {
    const command = JSON.parse(raw);
    dispatchCount++;
    const result = await h.call(command.command, command.args);
    socket.send(JSON.stringify({ ...result, id: command.id }));
  });
  assert.equal(data(await call('get_document')).name, 'Test file');
  const create = await call('create_node', { type: 'TEXT', props: { characters: 'Hello', fontSize: 24 } });
  assert.equal(create.isError, undefined);
  const nodeId = data(create).id;
  assert.equal(data(await call('get_node', { nodeId })).characters, 'Hello');
  assert.equal(data(await call('update_node', { nodeId, props: { characters: 'World' } })).characters, 'World');
  assert.equal((await call('export_node', { nodeId })).content[0].type, 'image');
  assert.equal(data(await call('export_node', { nodeId, format: 'SVG' })).svg, '<svg/>');
  const imageTarget = data(await call('create_node', { type: 'RECTANGLE' })).id;
  const imagePath = join(tmpdir(), `figma-local-image-${process.pid}-${Date.now()}.png`);
  t.after(() => rm(imagePath, { force: true }));
  await writeFile(imagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLwvwAAAABJRU5ErkJggg==', 'base64'));
  const imported = data(await call('set_image_fill_from_path', { nodeId: imageTarget, imagePath }));
  assert.equal(imported.source.mimeType, 'image/png');
  const before = dispatchCount;
  assert.equal((await call('update_node', { nodeId, props: { width: -2 } })).isError, true);
  assert.equal((await call('update_node', { nodeId, props: { arbitraryCode: 'x' } })).isError, true);
  assert.equal(dispatchCount, before, 'invalid input never reaches the plugin');
  assert.equal(data(await call('delete_node', { nodeId })).deleted.id, nodeId);
  assert.equal((await call('get_node', { nodeId })).isError, true);
  const failedReadLog = data(await call('get_diagnostics', { errorsOnly: true, limit: 200 })).entries;
  const failedRead = failedReadLog.findLast(e => e.command === 'get_node' && e.event === 'operation_result');
  assert.ok(failedRead.requestId);
  assert.equal(failedRead.code, 'PLUGIN_ERROR');
  assert.equal(failedReadLog.filter(e => e.command === 'get_node' && e.sessionId === failedRead.sessionId).length, 1,
    'one failed plugin call produces one error event, while pre-dispatch errors remain logged');
  const guide = data(await call('create_style_guide', { name: 'Demo' }));
  assert.equal(guide.colors.length, 10);
  const brand = guide.colors.find(t => t.name === 'brand/primary');
  const page = data(await call('create_page', { name: 'Screens' }));
  const scene = data(await call('create_scene', { parentId: page.id, nodes: [
    { ref: 'button', type: 'COMPONENT', props: { name: 'Button', width: 160, height: 48, fillVariableId: brand.id } },
    { ref: 'label', parentRef: 'button', type: 'TEXT', props: { characters: 'Continue', textStyleId: guide.textStyles[3].id } },
  ] }));
  assert.equal(scene.nodes.length, 2);
  const instance = data(await call('create_instance', { componentId: scene.nodes[0].id, parentId: page.id }));
  assert.equal(instance.componentId, scene.nodes[0].id);
  assert.equal((await call('set_variable', { variableId: brand.id, value: '#FF0000' })).isError, undefined);
  const system = data(await call('get_design_system', { prefix: 'Demo' }));
  assert.equal(system.variables.find(v => v.id === brand.id).valuesByMode[guide.modeId].r, 1);
  const count = dispatchCount;
  assert.equal((await call('create_scene', { nodes: [{ ref: 'x', parentRef: 'missing', type: 'FRAME' }] })).isError, true);
  assert.equal((await call('create_style_guide', { colors: [{ name: 'x', value: '#FFFFFF' }, { name: 'x', value: '#000000' }] })).isError, true);
  assert.equal(dispatchCount, count);
  const photo = data(await call('import_image', { dataBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6tGQAAAAASUVORK5CYII=', parentId: page.id, width: 240 }));
  assert.equal(photo.height, 120);
  const svg = data(await call('import_svg', { svg: '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0L24 24"/></svg>', width: 24, parentId: page.id }));
  assert.equal(svg.width, 24);
  const variants = data(await call('create_component_set', { name: 'Buttons', parentId: page.id,
    variants: ['Default', 'Hover'].map(State => ({ componentId: scene.nodes[0].id, properties: { State } })) }));
  const variantInstance = data(await call('create_instance', { componentId: variants.variants[0].id, parentId: page.id }));
  assert.equal(data(await call('set_instance_properties', { nodeId: variantInstance.id, properties: { State: 'Hover' } })).componentProperties.State.value, 'Hover');
  assert.equal((await call('set_prototype_link', { nodeId: variants.variants[0].id, destinationId: variants.variants[1].id, action: 'CHANGE_TO' })).isError, undefined);
  const screen = data(await call('create_node', { type: 'FRAME', parentId: page.id }));
  assert.equal(data(await call('set_prototype_start', { frameId: screen.id, name: 'Main' })).flowStartingPoints.length, 1);
  const dispatched = dispatchCount;
  assert.equal((await call('import_svg', { svg: '<svg><script/></svg>' })).isError, true);
  assert.equal((await call('create_component_set', { name: 'Duplicate', variants: [
    { componentId: scene.nodes[0].id, properties: { State: 'A' } }, { componentId: scene.nodes[0].id, properties: { State: 'A' } },
  ] })).isError, true);
  assert.equal(dispatchCount, dispatched, 'invalid assets and variant definitions never reach Figma');
});
