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

function automaticUI() {
  const elements = Object.fromEntries(['status', 'activity', 'connect', 'disconnect', 'token', 'intro', 'pairing', 'file-plan', 'page-budget', 'diagnostic-log'].map(id => [id, { value: '' }]));
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
    else commands.push(pluginMessage);
  } };
  const html = readFileSync(new URL('../plugin/ui.html', import.meta.url), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1].replace("const installationToken = '';", `const installationToken = '${'b'.repeat(64)}';`);
  vm.runInNewContext(script, {
    document: { getElementById: id => elements[id] }, window, parent, WebSocket,
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
