import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';

// No HTTP API, external requests, or Figma access token.
export async function createBridge({ port = 3055, timeoutMs = 120000, installationToken } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10 * 60 * 1000) {
    throw new Error('Invalid Figma bridge operation timeout');
  }
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
  wss.on('error', error => process.stderr.write(`Bridge error: ${error.message}\n`));
  function failPending(message) {
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.reject(new Error(message));
    pending = undefined;
  }
  wss.on('connection', (socket, request) => {
    // Figma's plugin iframe has an opaque (null) origin. Token authentication
    // is mandatory even for this origin; origin alone is never trusted.
    const origin = request.headers.origin;
    if (origin && origin !== 'null' && origin !== 'https://www.figma.com' && origin !== 'https://figma.com') {
      socket.close(1008, 'Origin not allowed');
      return;
    }
    let authenticated = false;
    const authTimer = setTimeout(() => socket.close(1008, 'Pairing timeout'), 5000);
    socket.on('error', () => {});
    socket.on('message', raw => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch { socket.close(1008, 'Invalid JSON'); return; }
      if (!message || typeof message !== 'object') { socket.close(1008, 'Invalid message'); return; }
      if (!authenticated) {
        const supplied = Buffer.from(typeof message.token === 'string' ? message.token : '');
        const expected = Buffer.from(token);
        if (message.type !== 'hello' || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
          socket.close(1008, 'Incorrect pairing code'); return;
        }
        if (peer) { socket.close(1008, 'Another plugin is connected'); return; }
        authenticated = true;
        clearTimeout(authTimer);
        peer = socket;
        document = message.document;
        socket.send(JSON.stringify({ type: 'ready' }));
        return;
      }
      if (message.type === 'document' && peer === socket) document = message.document;
      if (message.type === 'result') {
        if (pending && message.id === pending.id) {
          const current = pending;
          pending = undefined;
          clearTimeout(current.timer);
          if (typeof message.error === 'string') current.reject(new Error(message.error));
          else current.resolve(message.result);
        } else if (timedOut && message.id === timedOut.id && timedOut.socket === socket) {
          // The MCP client may already have given up, but the Plugin API work
          // still has a definitive completion signal. Keep the authenticated
          // socket alive and unblock the next command only after that signal.
          timedOut = undefined;
        }
      }
    });
    socket.on('close', () => {
      clearTimeout(authTimer);
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
      const automatic = Boolean(installationToken);
      return { connected: peer?.readyState === WebSocket.OPEN, port: wss.address().port,
        ...(automatic ? {} : { pairingCode: token }), pairingMode: automatic ? 'automatic' : 'manual', document,
        operation: pending ? 'running' : timedOut ? 'timed_out_waiting_result' : 'idle',
        instructions: automatic
          ? 'Run the plugin imported from generated/figma-plugin/manifest.json. It connects automatically. Keep its window open.'
          : 'Open the development plugin in Figma Desktop and paste pairingCode. Keep its window open.' };
    },
    request(command, args) {
      if (!peer || peer.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Figma plugin is not connected. Call get_connection and pair the plugin.'));
      if (pending) return Promise.reject(new Error('A Figma operation is running. Wait for its result before the next call.'));
      if (timedOut) return Promise.reject(new Error('The previous Figma operation timed out and may still be running. Wait for the plugin result; if it never arrives, reconnect the plugin before retrying.'));
      return new Promise((resolve, reject) => {
        const id = randomUUID();
        const timer = setTimeout(() => {
          if (!pending || pending.id !== id) return;
          const current = pending;
          pending = undefined;
          timedOut = { id, socket: peer };
          current.reject(new Error('Figma operation timed out. Its outcome is unknown; the plugin remains connected while its result is awaited. Inspect the file before retrying an edit.'));
        }, timeoutMs);
        pending = { id, resolve, reject, timer };
        peer.send(JSON.stringify({ type: 'command', id, command, args }), error => {
          if (error && pending?.id === id) failPending(`Failed to dispatch command: ${error.message}`);
        });
      });
    },
    async close() {
      failPending('Server shutting down');
      for (const client of wss.clients) client.terminate();
      await new Promise(resolve => wss.close(resolve));
    },
  };
}
