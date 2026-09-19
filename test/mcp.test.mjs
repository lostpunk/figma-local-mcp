import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { WebSocket } from 'ws';
import { pluginHarness } from './plugin-harness.mjs';
import { mkdtemp, cp, rm, readFile, mkdir, writeFile, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { version: packageVersion } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const { version: skillVersion } = JSON.parse(await readFile(new URL('../skills/figma-local-design/package.json', import.meta.url), 'utf8'));

for (const bundled of [false, true]) test(`MCP → WebSocket → plugin: full workflow (${bundled ? 'portable bundle without node_modules' : 'source'})`, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'figma portable $ space-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'generated'));
  await writeFile(join(directory, 'generated/pairing-key.json'), JSON.stringify({ token: 'c'.repeat(64) }));
  const entry = join(directory, bundled ? 'runtime/server.mjs' : 'src/server.mjs');
  if (bundled) {
    await mkdir(join(directory, 'runtime'));
    await cp(new URL('../runtime/server.mjs', import.meta.url), entry);
  } else {
    await cp(new URL('../src/', import.meta.url), join(directory, 'src'), { recursive: true });
    await cp(new URL('../package.json', import.meta.url), join(directory, 'package.json'));
    await symlink(fileURLToPath(new URL('../node_modules/', import.meta.url)), join(directory, 'node_modules'), 'junction');
  }
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [entry],
    env: { ...process.env, FIGMA_BRIDGE_PORT: '0' }, stderr: 'pipe' });
  const client = new Client({ name: 'test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(transport);
  assert.equal(client.getServerVersion().version, packageVersion);
  const call = (name, args = {}) => client.callTool({ name, arguments: args });
  const data = result => JSON.parse(result.content[0].text);
  const listed = await client.listTools();
  assert.equal(listed.tools.length, 37);
  assert.equal(listed.tools.find(t => t.name === 'preview_design_fixes').annotations.readOnlyHint, true);
  assert.equal(listed.tools.find(t => t.name === 'preview_audit_fixes').annotations.readOnlyHint, true);
  assert.equal(listed.tools.find(t => t.name === 'list_operations').annotations.readOnlyHint, true);
  assert.equal(listed.tools.find(t => t.name === 'preview_changes').annotations.readOnlyHint, true);
  assert.equal(listed.tools.find(t => t.name === 'apply_changes').annotations.readOnlyHint, false);
  assert.equal(listed.tools.find(t => t.name === 'audit_design').annotations.readOnlyHint, true);
  assert.equal(listed.tools.find(t => t.name === 'audit_design').annotations.destructiveHint, false);
  assert.equal(listed.tools.find(t => t.name === 'move_component').annotations.readOnlyHint, false);
  assert.equal(listed.tools.find(t => t.name === 'delete_node').annotations.destructiveHint, true);
  assert.equal((await call('get_document')).isError, true);
  const diagnostic = data(await call('get_diagnostics', { errorsOnly: true, limit: 10 }));
  assert.ok(diagnostic.entries.some(e => e.command === 'get_document' && e.level === 'error'));
  assert.match(diagnostic.logFile, /events\.jsonl$/);
  const connection = data(await call('get_connection'));
  assert.equal(connection.pairingMode, 'automatic');
  assert.equal(connection.pairingCode, undefined);
  assert.ok(!JSON.stringify(connection).includes('c'.repeat(64)));
  assert.deepEqual(connection.assetAccess.allowedRoots, []);
  const manifest = JSON.parse(await readFile(new URL('../plugin/manifest.json', import.meta.url), 'utf8'));
  const endpoint = new URL(manifest.networkAccess.devAllowedDomains[0]);
  const ui = await readFile(new URL('../plugin/ui.html', import.meta.url), 'utf8');
  const uiEndpoint = ui.match(/new WebSocket\(["']([^"']+)["']\)/)?.[1];
  assert.equal(new URL(uiEndpoint).href, endpoint.href, 'plugin connects to the manifest endpoint');
  endpoint.port = String(connection.port);
  const socket = new WebSocket(endpoint, { origin: 'null' });
  t.after(() => socket.terminate());
  await once(socket, 'open');
  const ready = once(socket, 'message');
  const h = pluginHarness();
  const document = await h.getDocument();
  assert.equal(document.pluginVersion, packageVersion);
  socket.send(JSON.stringify({ type: 'hello', token: 'c'.repeat(64), document }));
  assert.equal(JSON.parse((await ready)[0]).serverVersion, packageVersion);
  let dispatchCount = 0;
  socket.on('message', async raw => {
    const command = JSON.parse(raw);
    if (command.type !== 'command') return;
    dispatchCount++;
    const result = await h.call(command.command, command.args);
    socket.send(JSON.stringify({ ...result, id: command.id }));
  });
  assert.equal(data(await call('get_document')).name, 'Test file');
  const checked = data(await call('get_connection', { skillVersion }));
  assert.equal(checked.readiness.ready, true);
  assert.deepEqual(checked.readiness.versions, { server: packageVersion, plugin: packageVersion, skill: packageVersion });
  assert.equal(checked.readiness.skillVersionChecked, true);
  const retryArgs = { _operationId: checked.nextOperationId, type: 'RECTANGLE', props: { name: 'Exactly once' } };
  const first = data(await call('create_node', retryArgs));
  const countAfterFirst = dispatchCount;
  assert.equal(data(await call('create_node', retryArgs)).id, first.id);
  assert.equal(dispatchCount, countAfterFirst);
  assert.equal(data(await call('get_operation', { operationId: checked.nextOperationId })).result.id, first.id);
  await call('get_connection', { skillVersion: '0.7.3' });
  assert.equal((await call('create_node', { type: 'RECTANGLE' })).isError, true);
  assert.equal(dispatchCount, countAfterFirst, 'skill mismatch blocks writes before dispatch');
  await call('get_connection', { skillVersion });

  const beforeInvalidPlan = dispatchCount;
  assert.equal((await call('preview_changes', { changes: [{ nodeId: first.id, props: { characters: 'Not supported' } }] })).isError, true);
  assert.equal(dispatchCount, beforeInvalidPlan, 'invalid preview is rejected before plugin dispatch');
  const plan = data(await call('preview_changes', { changes: [{ nodeId: first.id, props: { width: 240, name: 'Unselected' } }] }));
  assert.equal(h.nodes.get(first.id).width, 100);
  const applyArgs = { planId: plan.planId, changeIds: [plan.changes.find(c => c.property === 'width').id], _operationId: data(await call('get_connection')).nextOperationId };
  const appliedResponse = await call('apply_changes', applyArgs);
  assert.equal(appliedResponse.isError, undefined);
  const applied = data(appliedResponse);
  const countAfterApply = dispatchCount;
  assert.deepEqual(data(await call('apply_changes', applyArgs)), applied);
  assert.equal(dispatchCount, countAfterApply, 'operation recovery does not reapply a consumed plan');
  assert.equal(h.nodes.get(first.id).width, 240);
  assert.equal(h.nodes.get(first.id).name, 'Exactly once');
  assert.equal((await call('apply_changes', { planId: plan.planId, changeIds: applyArgs.changeIds })).isError, true);

  const create = await call('create_node', { type: 'TEXT', props: { characters: 'Hello', fontSize: 24 } });
  assert.equal(create.isError, undefined);
  const nodeId = data(create).id;
  assert.equal(data(await call('get_node', { nodeId })).characters, 'Hello');
  const focusedRead = data(await call('get_node', { nodeId, fields: ['characters'], maxResponseBytes: 4096 }));
  assert.equal(focusedRead.characters, 'Hello');
  assert.equal(focusedRead.fills, undefined);
  assert.equal(data(await call('get_node', { nodeId, fields: [] })).characters, undefined);
  const beforeInvalidRead = dispatchCount;
  assert.equal((await call('get_node', { nodeId, fields: ['unknownProperty'] })).isError, true);
  assert.equal((await call('get_node', { nodeId, childOffset: -1 })).isError, true);
  assert.equal(dispatchCount, beforeInvalidRead);
  assert.equal(data(await call('update_node', { nodeId, props: { characters: 'World' } })).characters, 'World');
  assert.equal((await call('export_node', { nodeId })).content[0].type, 'image');
  assert.equal(data(await call('export_node', { nodeId, format: 'SVG' })).svg, '<svg/>');
  const imageTarget = data(await call('create_node', { type: 'RECTANGLE' })).id;
  const assetDir = join(directory, 'assets');
  await mkdir(assetDir);
  const imagePath = join(assetDir, 'photo.png');
  t.after(() => rm(imagePath, { force: true }));
  await writeFile(imagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLwvwAAAABJRU5ErkJggg==', 'base64'));
  const dispatchBeforeDenied = dispatchCount;
  for (const [name, args] of [
    ['set_image_fill_from_path', { nodeId: imageTarget, imagePath }],
    ['import_image', { filePath: imagePath }],
    ['import_svg', { filePath: imagePath }],
  ]) {
    const denied = await call(name, args);
    assert.equal(denied.isError, true);
    assert.match(denied.content[0].text, /disabled/);
  }
  assert.equal(dispatchCount, dispatchBeforeDenied);
  await writeFile(join(directory, 'generated/asset-access.json'), JSON.stringify({ version: 1, allowedRoots: [assetDir] }));
  const imported = data(await call('set_image_fill_from_path', { nodeId: imageTarget, imagePath }));
  assert.equal(imported.source.mimeType, 'image/png');
  assert.equal((await call('import_image', { filePath: imagePath, parentId: h.page.id })).isError, undefined);
  const svgPath = join(assetDir, 'icon.svg');
  await writeFile(svgPath, '<svg><path d="M0 0L10 10"/></svg>');
  assert.equal((await call('import_svg', { filePath: svgPath, parentId: h.page.id })).isError, undefined);
  const outsidePath = join(directory, 'outside.png');
  await cp(imagePath, outsidePath);
  const beforeOutside = dispatchCount;
  for (const [name, args] of [
    ['set_image_fill_from_path', { nodeId: imageTarget, imagePath: outsidePath }],
    ['import_image', { filePath: outsidePath }], ['import_svg', { filePath: outsidePath }],
  ]) {
    const denied = await call(name, args);
    assert.equal(denied.isError, true);
    assert.match(denied.content[0].text, /outside/);
  }
  assert.equal(dispatchCount, beforeOutside);
  await writeFile(join(directory, 'generated/asset-access.json'), JSON.stringify({ version: 1, allowedRoots: [] }));
  assert.equal((await call('set_image_fill_from_path', { nodeId: imageTarget, imagePath })).isError, true);
  assert.equal(dispatchCount, beforeOutside, 'revocation takes effect without server restart');
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
  const syncPreview = data(await call('sync_style_guide', { collectionId: guide.collectionId, colors: [{ name: 'surface', value: '#eeeeee' }] }));
  assert.equal(syncPreview.dryRun, true);
  assert.equal(syncPreview.changes[0].action, 'update');
  const syncApplied = data(await call('sync_style_guide', { collectionId: guide.collectionId, dryRun: false, colors: [{ name: 'surface', value: '#eeeeee' }] }));
  assert.equal(syncApplied.changes[0].id, syncPreview.changes[0].id);
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
  const firstResources = data(await call('get_design_system', { prefix: 'Demo', limit: 1 }));
  const nextResources = data(await call('get_design_system', { prefix: 'Demo', limit: 1,
    offsets: { variables: firstResources.pagination.variables.nextOffset }, revision: firstResources.revision }));
  assert.notEqual(nextResources.variables[0].id, firstResources.variables[0].id);
  const filteredResources = data(await call('get_design_system', { collectionId: system.collections[0].id,
    variableNamePrefix: system.variables.find(v => v.id === brand.id).name }));
  assert.ok(filteredResources.variables.some(v => v.id === brand.id));
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
  const undoBeforeAudit = h.undoCount;
  const quality = data(await call('audit_design', { nodeId: page.id, checkTextStyles: false }));
  assert.equal(quality.readOnly, true);
  assert.equal(quality.complete, true);
  assert.ok(quality.coverage.visited > 0);
  assert.equal(h.undoCount, undoBeforeAudit);
  const auditFrame = data(await call('create_node', { type: 'FRAME', props: { width: 200, height: 100 } }));
  const outside = data(await call('create_node', { type: 'RECTANGLE', parentId: auditFrame.id, props: { x: 190, y: 0, width: 40, height: 40 } }));
  const fixes = data(await call('preview_audit_fixes', { nodeId: auditFrame.id, nodeIds: [outside.id] }));
  assert.equal(fixes.plan.changes[0].after, 160);
  assert.equal((await call('apply_changes', { planId: fixes.plan.planId, changeIds: fixes.plan.changes.map(c => c.id) })).isError, undefined);
  assert.equal(data(await call('audit_design', { nodeId: auditFrame.id, checkTextStyles: false })).findings.length, 0);
  const beforeHistory = dispatchCount;
  const history = data(await call('list_operations', { limit: 1 }));
  assert.equal(history.entries[0].command, 'apply_changes');
  assert.equal(dispatchCount, beforeHistory, 'history reads never reach Figma');
});
