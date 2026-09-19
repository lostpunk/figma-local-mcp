import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { pluginHarness } from './plugin-harness.mjs';

test('UI relays plugin responses with null source and ignores unmatched results', async () => {
  const { figma } = pluginHarness();
  const elements = Object.fromEntries(['status', 'activity', 'connect', 'disconnect', 'token', 'file-plan', 'page-budget'].map(id => [id, { value: 'a'.repeat(64) }]));
  const sent = [];
  let websocket;
  let pending;
  class WebSocket {
    static OPEN = 1;
    readyState = 1;
    constructor() { websocket = this; }
    send(data) { sent.push(JSON.parse(data)); }
    close() { this.readyState = 3; }
  }
  const window = {};
  figma.ui.postMessage = pluginMessage => window.onmessage({ source: null, data: { pluginMessage } });
  const parent = { postMessage: message => { pending = figma.ui.onmessage(message.pluginMessage); } };
  const html = readFileSync(new URL('../plugin/ui.html', import.meta.url), 'utf8');
  vm.runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], {
    document: { getElementById: id => elements[id] }, window, parent, WebSocket, setTimeout, clearTimeout,
  });
  await pending;
  elements.connect.onclick();
  websocket.onopen();
  assert.equal(sent[0].document.name, 'Test file');
  window.onmessage({ source: null, data: null });
  window.onmessage({ source: null, data: { pluginMessage: { type: 'result', id: 'unrelated' } } });
  assert.equal(sent.length, 1);
  websocket.onmessage({ data: JSON.stringify({ type: 'command', id: 'request-1', command: 'get_document', args: {} }) });
  await pending;
  assert.equal(sent.length, 2);
  assert.equal(sent[1].id, 'request-1');
  assert.equal(sent[1].result.name, 'Test file');
  assert.equal(elements.activity.textContent, 'Операция завершена');
});

function automaticUI({ confirmMode = true } = {}) {
  const elements = Object.fromEntries(['status', 'activity', 'connect', 'disconnect', 'token', 'intro', 'pairing', 'file-plan', 'page-budget', 'diagnostic-log', 'versions', 'recovery', 'copy-report', 'support-report', 'copy-status', 'quality', 'quality-summary', 'quality-action', 'quality-findings', 'quality-focus-status', 'indicator', 'indicator-label', 'signal', 'toggle-panel', 'panel-content', 'notice', 'notice-text', 'acknowledge', 'move-left', 'move-right'].map(id => [id, { value: '', children: [], attributes: {}, setAttribute(k, v) { this.attributes[k] = v; }, focus() {}, select() {}, appendChild(c) { this.children.push(c); }, replaceChildren() { this.children = []; } }]));
  const sockets = [], timers = new Map(), commands = [];
  let nextTimer = 1;
  class WebSocket {
    static OPEN = 1;
    static CLOSED = 3;
    readyState = 1;
    sent = [];
    constructor() { sockets.push(this); }
    send(raw) { this.sent.push(JSON.parse(raw)); }
    close(code = 1000) { this.readyState = 3; this.onclose?.({ code }); }
    receive(data) { this.onmessage({ data: JSON.stringify(data) }); }
  }
  const window = {};
  const reply = pluginMessage => window.onmessage({ source: null, data: { pluginMessage } });
  const parent = { postMessage({ pluginMessage }) {
    if (pluginMessage.type === 'init') reply({ type: 'document', document: { name: 'Auto file' } });
    else {
      commands.push(pluginMessage);
      if (confirmMode && pluginMessage.type === 'presentation-mode') reply({ type: 'presentation-state', compact: pluginMessage.compact });
    }
  } };
  const html = readFileSync(new URL('../plugin/ui.html', import.meta.url), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1].replace("const installationToken = '';", `const installationToken = '${'b'.repeat(64)}';`);
  vm.runInNewContext(script, {
    document: { getElementById: id => elements[id], createElement: () => ({ children: [], appendChild(c) { this.children.push(c); } }) }, window, parent, WebSocket,
    setTimeout(fn) { const id = nextTimer++; timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  return { elements, sockets, timers, commands, reply,
    tick() { const [id, fn] = timers.entries().next().value; timers.delete(id); fn(); } };
}

test('installed UI connects without input, reconnects, and respects Disconnect and auth failure', () => {
  const h = automaticUI();
  assert.equal(h.elements.pairing.hidden, true);
  assert.equal(h.sockets.length, 1);
  h.sockets[0].onopen();
  assert.equal(h.sockets[0].sent[0].token, 'b'.repeat(64));
  assert.equal(h.sockets[0].sent[0].document.name, 'Auto file');
  h.sockets[0].receive({ type: 'ready' });
  h.sockets[0].close(1006);
  assert.equal(h.timers.size, 1);
  h.tick();
  assert.equal(h.sockets.length, 2);
  h.sockets[1].close(1006);
  h.elements.disconnect.onclick();
  assert.equal(h.timers.size, 0);
  h.elements.connect.onclick();
  h.sockets.at(-1).close(1008);
  assert.equal(h.timers.size, 0);
});

test('automatic reconnect waits for an interrupted command and never replays it', () => {
  const h = automaticUI();
  h.sockets[0].receive({ type: 'command', id: 'edit-1', command: 'create_scene', args: {} });
  h.sockets[0].close(1006);
  assert.equal(h.timers.size, 0);
  h.reply({ type: 'result', id: 'edit-1', result: {} });
  assert.equal(h.sockets[0].sent.length, 0, 'late result is not sent to a closed socket');
  h.tick();
  h.sockets[1].onopen();
  assert.equal(h.commands.length, 1);
  assert.equal(h.sockets[1].sent.length, 1);
  assert.equal(h.sockets[1].sent[0].type, 'hello');
  h.sockets[1].receive({ type: 'ready' });
  assert.equal(h.sockets[1].sent[1].event, 'late_result');
  assert.equal(h.sockets[1].sent[1].id, 'edit-1');
  assert.equal('result' in h.sockets[1].sent[1], false);
  assert.match(h.elements['diagnostic-log'].textContent, /LATE_RESULT/);
});

test('plugin journal bounds history, redacts secrets and displays errors as text', () => {
  const h = automaticUI();
  for (let n = 0; n < 60; n++) {
    h.sockets[0].receive({ type: 'command', id: 'request-' + n, command: 'get_node', args: { secret: 'PRIVATE CONTENT' } });
    h.reply({ type: 'result', id: 'request-' + n, error: '<b>fail</b> token=' + 'a'.repeat(64) });
  }
  const content = h.elements['diagnostic-log'].textContent;
  assert.equal(content.split('\n').length, 50);
  assert.match(content, /<b>fail<\/b>/); // textContent, never interpreted as HTML
  assert.doesNotMatch(content, /a{64}|PRIVATE CONTENT/);
});

test('UI exposes declared file plan and refreshes document metadata after authentication', () => {
  const h = automaticUI();
  h.sockets[0].receive({ type: 'ready' });
  h.elements['file-plan'].value = 'starter';
  h.elements['file-plan'].onchange();
  assert.equal(h.commands[0].type, 'set-plan');
  assert.equal(h.commands[0].plan, 'starter');
  h.reply({ type: 'document', document: { name: 'Auto file', capabilities: {
    plan: 'starter', planSource: 'user_declared', pageCount: 3, effectivePageLimit: 3,
  } } });
  assert.match(h.elements['page-budget'].textContent, /Страниц: 3; предел 3/);
  assert.equal(h.sockets[0].sent.at(-1).type, 'document');
  h.sockets[0].receive(null);
  assert.equal(h.sockets[0].readyState, 3);
});

test('support report excludes content, keys and raw error text with clipboard fallback', async () => {
  const h = automaticUI();
  h.reply({ type: 'document', document: { name: 'SECRET FILE', pluginVersion: '0.7.5' } });
  h.sockets[0].receive({ type: 'ready', serverVersion: '0.7.5' });
  h.sockets[0].receive({ type: 'command', id: 'secret-node-id', command: 'create_node', args: { name: 'SECRET CONTENT' } });
  h.reply({ type: 'result', id: 'secret-node-id', error: 'SECRET CONTENT token=abcd /Users/private/file' });
  await h.elements['copy-report'].onclick();
  const report = h.elements['support-report'].value;
  assert.equal(h.elements['support-report'].hidden, false);
  assert.equal(JSON.parse(report).lastErrorCode, 'PLUGIN_ERROR');
  assert.doesNotMatch(report, /SECRET|abcd|secret-node-id|Users|b{64}/);
});
test('reconnect returns the finished result without re-executing the edit', () => {
  const h = automaticUI();
  h.sockets[0].receive({ type: 'command', id: 'edit-1', command: 'create_node', args: {} });
  h.sockets[0].receive({ type: 'command', id: 'edit-1', command: 'create_node', args: {} });
  assert.equal(h.commands.length, 1);
  h.sockets[0].close(1006);
  h.reply({ type: 'result', id: 'edit-1', result: { id: '2:1' } });
  h.tick(); h.sockets[1].receive({ type: 'ready' });
  const result = h.sockets[1].sent.find(m => m.type === 'recovered_result');
  assert.equal(result.result.id, '2:1'); assert.equal(h.commands.length, 1);
});


test('quality panel distinguishes audit, proposals and unverified edits; focus is explicit', async () => {
  const h = automaticUI();
  const run = (id, command, result) => {
    h.sockets[0].receive({ type: 'command', id, command, args: { nodeId: 'page' } });
    h.reply({ type: 'result', id, result });
  };
  const audit = { rootId: 'page', coverage: { checked: 80 }, findingCount: 1, complete: true,
    findings: [{ nodeId: 'n1', name: '<img onerror=bad>', code: 'TEXT_RENDER_OUTSIDE_BOX', message: 'Text overflow' }] };
  run('a1', 'audit_design', audit);
  assert.match(h.elements['quality-summary'].textContent, /80.*1/);
  const row = h.elements['quality-findings'].children[0];
  assert.match(row.children[0].textContent, /<img onerror=bad>/);
  assert.equal(h.commands.some(c => c.type === 'focus-finding'), false);
  row.children[1].onclick(); assert.equal(h.commands.at(-1).type, 'focus-finding');
  run('p1', 'preview_audit_fixes', { plan: null, skipped: [{ nodeId: 'n1', reason: 'Needs review' }] });
  assert.match(h.elements['quality-action'].textContent, /ещё не применены/);
  run('w1', 'apply_changes', { nodeIds: ['n1'] });
  assert.match(h.elements['quality-action'].textContent, /Требуется повторный аудит/);
  run('a2', 'audit_design', { ...audit, findings: [], findingCount: 0 });
  assert.match(h.elements['quality-summary'].textContent, /Замечаний: 0.*проверке: 1/);
  await h.elements['copy-report'].onclick();
  assert.doesNotMatch(h.elements['support-report'].value, /n1|overflow|onerror/);
});
test('focus handler only selects layers returned by the current report', async () => {
  const h = pluginHarness(); const frame = h.node('FRAME', 'Screen', h.page);
  const shape = h.node('RECTANGLE', 'Outside', frame); shape.x = 150;
  await h.figma.ui.onmessage({ type: 'focus-finding', nodeId: shape.id });
  assert.equal(h.page.selection.length, 0);
  await h.call('audit_design', { nodeId: frame.id, checkTextStyles: false });
  await h.figma.ui.onmessage({ type: 'focus-finding', nodeId: shape.id });
  assert.equal(h.page.selection[0].id, shape.id);
});

test('compact controls preserve the active connection and operation, and restore the saved mode', () => {
  const h = automaticUI(), socket = h.sockets[0];
  h.reply({ type: 'presentation-state', compact: true });
  socket.receive({ type: 'ready' });
  assert.equal(h.elements['indicator-label'].textContent, 'Подключено');
  socket.receive({ type: 'command', id: 'busy', command: 'get_document', args: {} });
  assert.equal(h.elements.indicator.className, 'running');
  h.elements['toggle-panel'].onclick();
  assert.equal(h.elements['panel-content'].hidden, false);
  assert.equal(h.commands.at(-1).type, 'presentation-mode');
  h.elements['toggle-panel'].onclick();
  assert.equal(h.elements['panel-content'].hidden, true);
  assert.equal(socket.readyState, 1); assert.equal(h.sockets.length, 1);
  h.reply({ type: 'result', id: 'busy', result: {} });
  assert.equal(h.elements.indicator.className, 'ready');
  assert.equal(socket.sent.filter(m => m.type === 'result').length, 1);
  h.elements['move-right'].onclick(); assert.equal(h.commands.at(-1).edge, 'right');
});
test('important events remain visible across successful reads, never auto-expand, and stop pulsing on review', () => {
  const h = automaticUI(), socket = h.sockets[0];
  h.reply({ type: 'presentation-state', compact: true }); socket.receive({ type: 'ready' });
  socket.receive({ type: 'command', id: 'bad', command: 'apply_changes', args: {} });
  h.reply({ type: 'result', id: 'bad', error: 'Rollback incomplete' });
  assert.equal(h.elements.indicator.className, 'error pulse');
  assert.equal(h.elements['panel-content'].hidden, true);
  socket.receive({ type: 'command', id: 'good', command: 'get_document', args: {} });
  h.reply({ type: 'result', id: 'good', result: {} });
  assert.match(h.elements.indicator.className, /error/);
  h.elements.indicator.onclick();
  assert.equal(h.elements['panel-content'].hidden, false);
  assert.equal(h.elements.indicator.className, 'ready');
  assert.equal(h.elements.acknowledge.hidden, true);
  assert.match(h.elements['notice-text'].textContent, /ошибкой/);
});
test('audit warnings and storage problems use text and icons, and warnings do not conceal unread errors', () => {
  const h = automaticUI(), socket = h.sockets[0];
  socket.receive({ type: 'command', id: 'audit', command: 'audit_design', args: {} });
  h.reply({ type: 'result', id: 'audit', result: { rootId: 'p', coverage: { checked: 1 }, complete: false, findingCount: 0, findings: [] } });
  assert.equal(h.elements.indicator.className, 'warning pulse');
  assert.equal(h.elements.signal.textContent, '!');
  assert.match(h.elements['indicator-label'].textContent, /макет/);
  socket.close(1008);
  h.reply({ type: 'presentation-error', error: 'Cannot save preferences' });
  assert.match(h.elements.indicator.className, /error/);
  assert.match(h.elements['notice-text'].textContent, /отклонено/);
});

test('acknowledging a version warning does not claim the mismatched connection is ready', () => {
  const h = automaticUI();
  h.reply({ type: 'document', document: { pluginVersion: '0.7.23' } });
  h.sockets[0].receive({ type: 'ready', serverVersion: '0.7.21' });
  h.elements.indicator.onclick();
  assert.equal(h.elements.indicator.className, 'warning');
  assert.match(h.elements['indicator-label'].textContent, /Версии/);
  assert.doesNotMatch(h.elements.status.textContent, /может.*редактировать/);
  h.reply({ type: 'document', document: { pluginVersion: '0.7.21' } });
  assert.equal(h.elements.indicator.className, 'ready');
});
test('failed expansion leaves the details hidden and the error unread until resize is confirmed', () => {
  const h = automaticUI({ confirmMode: false }), socket = h.sockets[0];
  h.reply({ type: 'presentation-state', compact: true }); socket.receive({ type: 'ready' });
  socket.receive({ type: 'command', id: 'bad', command: 'apply_changes', args: {} });
  h.reply({ type: 'result', id: 'bad', error: 'Rollback incomplete' });
  h.elements.indicator.onclick();
  assert.equal(h.elements['panel-content'].hidden, true);
  assert.match(h.elements.indicator.className, /error/);
  h.reply({ type: 'presentation-state', compact: true });
  h.reply({ type: 'presentation-error', error: 'Не удалось изменить размер окна.' });
  assert.equal(h.elements['panel-content'].hidden, true);
  assert.match(h.elements.indicator.className, /error/);
  assert.match(h.elements['diagnostic-log'].textContent, /PRESENTATION_ERROR/);
  h.elements.indicator.onclick(); h.reply({ type: 'presentation-state', compact: false });
  assert.equal(h.elements['panel-content'].hidden, false);
  assert.equal(h.elements.indicator.className, 'ready');
});

test('oversized Unicode results return a bounded error without disconnecting or replaying edits', () => {
  const h = automaticUI();
  const socket = h.sockets[0];
  socket.receive({ type: 'ready' });
  const id = '11111111-1111-1111-1111-111111111111:1';
  socket.receive({ type: 'command', id, command: 'create_scene', args: {} });
  h.reply({ type: 'result', id, result: { text: '🙂'.repeat(4 * 1024 * 1024) } });
  const error = socket.sent.find(message => message.id === id);
  assert.match(error.error, /RESPONSE_TOO_LARGE/);
  assert.match(error.error, /may already have completed/);
  assert.ok(Buffer.byteLength(JSON.stringify(error)) < 1024);
  assert.equal(socket.readyState, 1);
  assert.equal(h.commands.filter(message => message.type === 'command').length, 1);
  socket.close(1006);
  h.tick();
  h.sockets[1].receive({ type: 'ready' });
  const recovered = h.sockets[1].sent.find(message => message.type === 'recovered_result');
  assert.equal(recovered.id, id);
  assert.match(recovered.error, /RESPONSE_TOO_LARGE/);
});
