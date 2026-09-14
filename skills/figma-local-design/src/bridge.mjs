import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
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

// No HTTP API, external requests, or Figma access token.
export async function createBridge({ port = 3055, timeoutMs = 120000, installationToken, diagnostics } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000) throw new Error('Invalid Figma bridge operation timeout');
  const log = (level, event, fields) => diagnostics?.record(level, event, fields);
  if (installationToken !== undefined && !/^[a-f0-9]{64}$/.test(installationToken)) throw new Error('Invalid installation token');
  const token = installationToken ?? randomBytes(32).toString('hex');
  const wss = new WebSocketServer({ host: '127.0.0.1', port, maxPayload: 16 * 1024 * 1024 });
  await new Promise((resolve, reject) => {
    wss.once('listening', resolve);
    wss.once('error', reject);
  });
  let peer;
  let pending;
  let timedOut;
  let document;
  log('info', 'bridge_started');
  wss.on('error', error => log('error', 'bridge_error', { code: error.code, message: error.message }));
  function failPending(message, code = 'CONNECTION_LOST') {
    if (!pending) return;
    log('error', 'operation_failed', { requestId: pending.id, command: pending.command, durationMs: Date.now() - pending.startedAt, code, message, outcome: 'unknown' });
    clearTimeout(pending.timer);
    pending.reject(new BridgeOperationError(message, pending.id, code, Boolean(diagnostics)));
    pending = undefined;
  }
  wss.on('connection', (socket, request) => {
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
        log('info', 'plugin_connected', { pluginVersion: document?.pluginVersion });
        socket.send(JSON.stringify({ type: 'ready' }));
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
      if (message.type === 'result' && timedOut && message.id === timedOut.id && timedOut.socket === socket) {
        log(typeof message.error === 'string' ? 'error' : 'warn', 'plugin_late_result', { requestId: timedOut.id, command: timedOut.command, durationMs: Date.now() - timedOut.startedAt, message: typeof message.error === 'string' ? message.error : undefined, outcome: typeof message.error === 'string' ? 'plugin_error' : 'plugin_completed' });
        timedOut = undefined;
      }
      if (message.type === 'result' && pending && message.id === pending.id) {
        const current = pending;
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
    info() {
      return { connected: peer?.readyState === WebSocket.OPEN, port: wss.address().port,
        ...(installationToken ? {} : { pairingCode: token }), operation: pending ? 'running' : timedOut ? 'timed_out_waiting_result' : 'idle', pairingMode: installationToken ? 'automatic' : 'manual', document,
        instructions: installationToken
          ? 'Run the plugin imported from generated/figma-plugin/manifest.json. It connects automatically. Keep its window open.'
          : 'Open the development plugin in Figma Desktop and paste pairingCode. Keep its window open.' };
    },
    request(command, args) {
      if (!peer || peer.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Figma plugin is not connected. Call get_connection and pair the plugin.'));
      if (pending) return Promise.reject(new Error('A Figma operation is running. Wait for its result before the next call.'));
      if (timedOut) return Promise.reject(new Error('The previous Figma operation timed out and may still be running. Wait for the plugin result; if it never arrives, reconnect the plugin before retrying.'));
      return new Promise((resolve, reject) => {
        const id = randomUUID();
        const startedAt = Date.now();
        log('info', 'operation_started', { requestId: id, command });
        const timer = setTimeout(() => {
          if (!pending || pending.id !== id) return;
          timedOut = { id, socket: peer, command, startedAt };
          failPending('Figma operation timed out. Its outcome is unknown; the plugin remains connected while its result is awaited. Inspect the file before retrying an edit.', 'TIMEOUT');
        }, timeoutMs);
        pending = { id, resolve, reject, timer, command, startedAt };
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
