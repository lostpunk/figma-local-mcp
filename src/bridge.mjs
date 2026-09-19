import responseLimits from './response-limits.json' with { type: 'json' };
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createOperations } from './operations.mjs';
import { createOperationHistory } from './operation-history.mjs';
import { VERSION, readiness } from './readiness.mjs';
import { WebSocketServer, WebSocket } from 'ws';

export class BridgeOperationError extends Error {
  constructor(message, requestId, code, diagnosticsRecorded) {
    super(message);
    this.name = 'BridgeOperationError';
    this.requestId = requestId;
    this.code = code;
    this.diagnosticsRecorded = diagnosticsRecorded;
  }
}

// Local WebSocket transport only; no external requests or Figma access token.
export async function createBridge({ port = 3055, timeoutMs = 120000, installationToken, diagnostics, onLocalClient, historyDirectory } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000) throw new Error('Invalid Figma bridge operation timeout');
  const log = (level, event, fields) => diagnostics?.record(level, event, fields);
  if (typeof installationToken !== 'string' || !/^[a-f0-9]{64}$/.test(installationToken)) throw new Error('Invalid installation token. Run scripts/setup.mjs and import the generated plugin.');
  const token = installationToken;
  const wss = new WebSocketServer({ host: '127.0.0.1', port, maxPayload: responseLimits.transportBytes });
  await new Promise((resolve, reject) => {
    wss.once('listening', resolve);
    wss.once('error', reject);
  });
  let peer;
  let pending;
  let timedOut;
  let document;
  let pluginSessionId;
  let operations;
  try {
    operations = createOperations({ history: historyDirectory ? createOperationHistory({ directory: historyDirectory, port: wss.address().port, installationToken }) : undefined });
  } catch (error) { await new Promise(resolve => wss.close(resolve)); throw error; }
  function historyHealth() {
    if (!operations.info().healthy) log('error', 'operation_history_unavailable', { code: 'HISTORY_WRITE_FAILED', outcome: 'inspect_after_error' });
    return operations.info();
  }
  log('info', 'bridge_started');
  wss.on('error', error => log('error', 'bridge_error', { code: error.code, message: error.message }));
  function failPending(message, code = 'CONNECTION_LOST') {
    if (!pending) return;
    log('error', 'operation_failed', { requestId: pending.id, command: pending.command, durationMs: Date.now() - pending.startedAt, code, message, outcome: 'unknown' });
    if (pending.record) { operations.mark(pending.id, code === 'TIMEOUT' ? 'waiting_result' : 'unknown'); historyHealth(); }
    clearTimeout(pending.timer);
    pending.reject(new BridgeOperationError(message, pending.id, code, Boolean(diagnostics)));
    pending = undefined;
  }
  wss.on('connection', (socket, request) => {
    if (request.url === '/mcp-bridge') {
      if (onLocalClient && !request.headers.origin) onLocalClient(socket);
      else socket.close(1008, 'Local clients only');
      return;
    }
    // Figma's plugin iframe has an opaque (null) origin. Token authentication
    // is mandatory even for this origin; origin alone is never trusted.
    const origin = request.headers.origin;
    if (origin && origin !== 'null' && origin !== 'https://www.figma.com' && origin !== 'https://figma.com') {
      log('warn', 'connection_rejected', { code: 'ORIGIN_REJECTED' });
      socket.close(1008, 'Origin not allowed');
      return;
    }
    let authenticated = false;
    const authTimer = setTimeout(() => socket.close(1008, 'Pairing timeout'), 5000);
    socket.on('error', error => log('error', 'socket_error', { code: error.code, message: error.message }));
    socket.on('message', raw => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch { socket.close(1008, 'Invalid JSON'); return; }
      if (!message || typeof message !== 'object') { socket.close(1008, 'Invalid message'); return; }
      if (!authenticated) {
        const supplied = Buffer.from(typeof message.token === 'string' ? message.token : '');
        const expected = Buffer.from(token);
        if (message.type !== 'hello' || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
          log('warn', 'connection_rejected', { code: 'AUTH_FAILED' });
          socket.close(1008, 'Incorrect pairing code'); return;
        }
        if (peer) { socket.close(1008, 'Another plugin is connected'); return; }
        authenticated = true;
        clearTimeout(authTimer);
        peer = socket;
        document = message.document;
        pluginSessionId = typeof message.pluginSessionId === 'string' && message.pluginSessionId.length <= 200 ? message.pluginSessionId : undefined;
        log('info', 'plugin_connected', { pluginVersion: document?.pluginVersion });
        socket.send(JSON.stringify({ type: 'ready', serverVersion: VERSION, serverSessionId: operations.sessionId }));
        return;
      }
      if (message.type === 'document' && peer === socket) document = message.document;
      if (message.type === 'diagnostic' && peer === socket && message.event === 'late_result') {
        log(message.failed ? 'error' : 'warn', 'plugin_late_result', {
          requestId: message.id, command: message.command, durationMs: message.durationMs,
          message: typeof message.error === 'string' ? message.error : undefined,
          outcome: message.failed ? 'plugin_error' : 'plugin_completed',
        });
      }
      if (message.type === 'recovered_result' && peer === socket && pluginSessionId) {
        try {
          const record = operations.lookup(message.id);
          if (record.pluginSessionId === pluginSessionId && ['unknown', 'waiting_result', 'completed', 'failed'].includes(record.status)) {
            if (['unknown', 'waiting_result'].includes(record.status)) operations.finish(message.id, message);
            if (historyHealth().healthy) socket.send(JSON.stringify({ type: 'result_ack', id: message.id }));
            log('info', 'operation_recovered', { requestId: message.id, command: record.command, outcome: record.status });
          }
        } catch { /* Missing/expired records or another plugin session must never be guessed. */ }
      }
      if (message.type === 'result' && timedOut && message.id === timedOut.id && timedOut.socket === socket) {
        log(typeof message.error === 'string' ? 'error' : 'warn', 'plugin_late_result', { requestId: timedOut.id, command: timedOut.command, durationMs: Date.now() - timedOut.startedAt, message: typeof message.error === 'string' ? message.error : undefined, outcome: typeof message.error === 'string' ? 'plugin_error' : 'plugin_completed' });
        operations.finish(timedOut.id, message);
        if (timedOut.record && historyHealth().healthy) socket.send(JSON.stringify({ type: 'result_ack', id: message.id }));
        timedOut = undefined;
      }
      if (message.type === 'result' && pending && message.id === pending.id) {
        const current = pending;
        operations.finish(current.id, message);
        if (current.record && historyHealth().healthy) socket.send(JSON.stringify({ type: 'result_ack', id: message.id }));
        pending = undefined;
        clearTimeout(current.timer);
        log(typeof message.error === 'string' ? 'error' : 'info', 'operation_result', {
          requestId: current.id, command: current.command, durationMs: Date.now() - current.startedAt,
          code: typeof message.error === 'string' ? 'PLUGIN_ERROR' : undefined,
          message: typeof message.error === 'string' ? message.error : undefined,
          outcome: typeof message.error === 'string' ? 'inspect_after_error' : 'completed',
        });
        if (typeof message.error === 'string') current.reject(new BridgeOperationError(message.error, current.id, 'PLUGIN_ERROR', Boolean(diagnostics)));
        else current.resolve(message.result);
      }
    });
    socket.on('close', closeCode => {
      clearTimeout(authTimer);
      if (authenticated) log('warn', 'plugin_disconnected', { closeCode });
      if (peer === socket) {
        peer = undefined;
        document = undefined;
        if (timedOut?.socket === socket) timedOut = undefined;
        failPending('Plugin disconnected. A dispatched edit may have completed; inspect before retrying.');
      }
    });
  });
  return {
    getOperation(id) { return operations.view(id); },
    listOperations(args) { return operations.list(args); },
    info(skillVersion) {
      const operation = pending ? 'running' : timedOut ? 'timed_out_waiting_result' : 'idle';
      const ready = readiness({ connected: peer?.readyState === WebSocket.OPEN, document, operation, skillVersion });
      const history = operations.info();
      if (!history.healthy) { ready.ready = false; ready.issues.push({ code: 'HISTORY_WRITE_FAILED', action: 'Проверьте свободное место и права локального журнала, затем перезапустите MCP. Не повторяйте неопределённые изменения.' }); }
      return { connected: peer?.readyState === WebSocket.OPEN, port: wss.address().port,
        operation,
        serverSessionId: operations.sessionId, nextOperationId: operations.nextId(),
        activeOperation: (pending ?? timedOut) ? { operationId: (pending ?? timedOut).id, command: (pending ?? timedOut).command, elapsedMs: Date.now() - (pending ?? timedOut).startedAt } : null,
        readiness: ready, history, pairingMode: 'automatic', document,
        instructions: 'Run the plugin imported from generated/figma-plugin/manifest.json. It connects automatically. Keep its window open.' };
    },
    request(command, args, { operationId, write = false } = {}) {
      if (write && operationId) {
        try {
          const previous = operations.existing(operationId, command, args);
          if (previous) {
            if (previous.status === 'completed' && !previous.resultExpired) return Promise.resolve(previous.result);
            const message = previous.status === 'failed' ? previous.error : `Operation is ${previous.status}${previous.resultExpired ? '; result expired' : ''}. Inspect get_operation; the edit was not replayed.`;
            return Promise.reject(new BridgeOperationError(message, operationId, 'OPERATION_NOT_REPLAYED', false));
          }
        } catch (error) { return Promise.reject(error); }
      }
      if (!peer || peer.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Figma plugin is not connected. Call get_connection and pair the plugin.'));
      if (write && !operations.info().healthy) return Promise.reject(new Error('Operation history is unavailable; repair local storage and restart before editing.'));
      if (pending) return Promise.reject(new Error('A Figma operation is running. Wait for its result before the next call.'));
      if (timedOut) return Promise.reject(new Error('The previous Figma operation timed out and may still be running. Wait for the plugin result; if it never arrives, reconnect the plugin before retrying.'));
      return new Promise((resolve, reject) => {
        const id = write ? operationId ?? operations.nextId() : randomUUID();
        const record = write ? operations.start(id, command, args, pluginSessionId) : undefined;
        const startedAt = Date.now();
        log('info', 'operation_started', { requestId: id, command });
        const timer = setTimeout(() => {
          if (!pending || pending.id !== id) return;
          timedOut = { id, socket: peer, command, startedAt, record };
          failPending('Figma operation timed out. Its outcome is unknown; the plugin remains connected while its result is awaited. Inspect the file before retrying an edit.', 'TIMEOUT');
        }, timeoutMs);
        pending = { id, resolve, reject, timer, command, startedAt, record };
        peer.send(JSON.stringify({ type: 'command', id, command, args }), error => {
          if (error && pending?.id === id) failPending(`Failed to dispatch command: ${error.message}`);
        });
      });
    },
    async close() {
      log('info', 'bridge_stopping');
      failPending('Server shutting down');
      for (const client of wss.clients) client.terminate();
      await new Promise(resolve => wss.close(resolve));
    },
  };
}
