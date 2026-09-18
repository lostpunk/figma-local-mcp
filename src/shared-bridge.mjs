import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { createBridge, BridgeOperationError } from './bridge.mjs';
import { VERSION } from './readiness.mjs';

const protocol = 'figma-local-bridge-v1';
const nonce = () => randomBytes(32).toString('hex');
const validNonce = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const proof = (token, role, serverNonce, clientNonce, version) => createHmac('sha256', token).update(JSON.stringify([protocol, role, serverNonce, clientNonce, version])).digest('hex');
const equal = (a, b) => validNonce(a) && validNonce(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const errorWithCode = (message, code) => Object.assign(new Error(message), { code });

export async function createSharedWorker({ port, installationToken, diagnostics, timeoutMs = 120000, idleMs = 3000, historyDirectory }) {
  let bridge, idleTimer, closing;
  const clients = new Set(), waiting = new Set(), owners = new Map();
  const close = () => closing ??= (async () => {
    clearTimeout(idleTimer);
    for (const socket of [...clients, ...waiting]) socket.terminate();
    await bridge.close();
  })();
  function scheduleIdle() {
    clearTimeout(idleTimer);
    if (!clients.size && !closing) idleTimer = setTimeout(() => void close(), idleMs);
  }
  function localClient(socket) {
    if (closing || clients.size + waiting.size >= 32) { socket.close(1013, 'Bridge client limit'); return; }
    waiting.add(socket);
    const challenge = nonce(), clientId = randomUUID();
    let authenticated = false, inFlight = 0;
    const authTimer = setTimeout(() => socket.terminate(), 2000);
    const send = value => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value)); };
    socket.on('error', () => {});
    send({ type: 'challenge', protocol, version: VERSION, nonce: challenge });
    socket.on('message', async raw => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch { socket.close(1008, 'Invalid JSON'); return; }
      if (!message || typeof message !== 'object') { socket.close(1008, 'Invalid message'); return; }
      if (!authenticated) {
        if (message.type !== 'authenticate' || message.version !== VERSION || !validNonce(message.nonce)
          || !equal(message.proof, proof(installationToken, 'client', challenge, message.nonce, VERSION))) {
          socket.close(1008, 'Bridge authentication or version mismatch'); return;
        }
        authenticated = true; clearTimeout(authTimer); clearTimeout(idleTimer);
        waiting.delete(socket); clients.add(socket);
        send({ type: 'authenticated', proof: proof(installationToken, 'server', challenge, message.nonce, VERSION) });
        diagnostics?.record('info', 'mcp_client_connected');
        return;
      }
      if (message.type !== 'rpc' || typeof message.id !== 'string' || message.id.length > 80 || inFlight >= 8) {
        socket.close(1008, 'Invalid or excessive bridge request'); return;
      }
      inFlight++;
      try {
        let result;
        if (message.method === 'info') result = { ...bridge.info(message.skillVersion), transport: 'shared', clientCount: clients.size };
        else if (message.method === 'getOperation') result = bridge.getOperation(message.operationId);
        else if (message.method === 'listOperations') result = bridge.listOperations(message.args);
        else if (message.method === 'request') {
          if (typeof message.command !== 'string' || message.command.length > 100 || !message.args || typeof message.args !== 'object'
            || !message.options || typeof message.options.write !== 'boolean') throw new Error('Invalid bridge command');
          const { write, operationId } = message.options;
          if (write) {
            if (typeof operationId !== 'string' || operationId.length > 100) throw new Error('Missing operation ID');
            if (bridge.info(message.skillVersion).readiness.issues.some(issue => issue.code !== 'OPERATION_PENDING')) throw new Error('Plugin is not ready for edits');
            if (owners.has(operationId) && owners.get(operationId) !== clientId) throw new Error('Operation ID was claimed by another MCP client. Read get_connection for a fresh ID and inspect the file.');
          }
          const promise = bridge.request(message.command, message.args, message.options);
          if (write) {
            try {
              bridge.getOperation(operationId); owners.set(operationId, clientId);
              while (owners.size > 100) owners.delete(owners.keys().next().value);
            } catch { /* Rejected before dispatch; no ownership claimed. */ }
          }
          result = await promise;
        } else throw new Error('Unknown bridge method');
        send({ type: 'result', id: message.id, result });
      } catch (error) {
        send({ type: 'result', id: message.id, error: { message: error.message, code: error.code, requestId: error.requestId, diagnosticsRecorded: error.diagnosticsRecorded } });
      } finally { inFlight--; }
    });
    socket.on('close', () => {
      clearTimeout(authTimer); waiting.delete(socket); clients.delete(socket);
      if (authenticated) {
        diagnostics?.record('info', 'mcp_client_disconnected');
        scheduleIdle();
      }
    });
  }
  bridge = await createBridge({ port, installationToken, diagnostics, timeoutMs, onLocalClient: localClient, historyDirectory });
  scheduleIdle();
  return { close, info: () => ({ ...bridge.info(), clientCount: clients.size }) };
}

export function connectSharedBridge({ port, installationToken, timeoutMs = 120000 }) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/mcp-bridge`, { maxPayload: 16 * 1024 * 1024, handshakeTimeout: 2000 });
    let challenge, clientNonce, authenticated = false;
    const pending = new Map();
    function fail(error) {
      if (!authenticated) reject(error);
      for (const call of pending.values()) { clearTimeout(call.timer); call.reject(error); }
      pending.clear();
    }
    const authTimer = setTimeout(() => {
      fail(errorWithCode('Port is occupied by an old or incompatible bridge. Restart all Figma Local MCP clients.', 'BRIDGE_AUTH_TIMEOUT'));
      socket.terminate();
    }, 2500);
    function rpc(method, params = {}) {
      if (socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Shared bridge disconnected. An edit may have completed; inspect after reconnecting.'));
      if (pending.size >= 8) return Promise.reject(new Error('Too many pending bridge requests'));
      return new Promise((resolve, reject) => {
        const id = randomUUID();
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(errorWithCode('Shared bridge response timed out. Do not replay edits; inspect get_operation.', 'BRIDGE_TIMEOUT'));
        }, method === 'request' ? timeoutMs + 5000 : 5000);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ type: 'rpc', id, method, ...params }), error => {
          if (error) { clearTimeout(timer); pending.delete(id); reject(error); }
        });
      });
    }
    socket.on('error', error => { clearTimeout(authTimer); fail(error); });
    socket.on('close', code => {
      clearTimeout(authTimer);
      fail(errorWithCode('Shared bridge disconnected or authentication failed. Restart all clients if versions differ; inspect uncertain edits before retrying.', code === 1008 ? 'BRIDGE_AUTH_FAILED' : 'BRIDGE_DISCONNECTED'));
    });
    socket.on('message', raw => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch { socket.terminate(); return; }
      if (!authenticated) {
        if (!challenge && message?.type === 'challenge' && message.protocol === protocol && validNonce(message.nonce)) {
          if (message.version !== VERSION) {
            fail(errorWithCode('An older shared bridge is still running. Close all Figma Local MCP clients, wait a few seconds, then reopen them.', 'BRIDGE_VERSION_MISMATCH'));
            clearTimeout(authTimer); socket.terminate(); return;
          }
          challenge = message.nonce; clientNonce = nonce();
          // Never send the installation key to a service merely because it occupies this port.
          socket.send(JSON.stringify({ type: 'authenticate', version: VERSION, nonce: clientNonce, proof: proof(installationToken, 'client', challenge, clientNonce, VERSION) }));
        } else if (challenge && message?.type === 'authenticated' && equal(message.proof, proof(installationToken, 'server', challenge, clientNonce, VERSION))) {
          authenticated = true; clearTimeout(authTimer);
          resolve({ info: skillVersion => rpc('info', { skillVersion }), getOperation: operationId => rpc('getOperation', { operationId }),
            listOperations: args => rpc('listOperations', { args }),
            request: (command, args, options = {}) => rpc('request', { command, args, options: { write: false, ...options }, skillVersion: options.skillVersion }),
            async close() { socket.terminate(); } });
        } else { clearTimeout(authTimer); fail(new Error('Unrecognized or unauthenticated service on bridge port')); socket.terminate(); }
        return;
      }
      if (message?.type !== 'result') return;
      const call = pending.get(message.id); if (!call) return;
      pending.delete(message.id); clearTimeout(call.timer);
      if (message.error) call.reject(new BridgeOperationError(message.error.message, message.error.requestId, message.error.code, message.error.diagnosticsRecorded));
      else call.resolve(message.result);
    });
  });
}

export async function openSharedBridge({ port, installationToken, timeoutMs, entry, diagnostics }) {
  if (!validNonce(installationToken)) throw new Error('Invalid installation token. Run scripts/setup.mjs first.');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000) throw new Error('Invalid Figma bridge operation timeout');
  // Port 0 is intentionally isolated, for portable installation checks and tests.
  if (port === 0) return createBridge({ port, installationToken, timeoutMs, diagnostics });
  let launched = false, spawnError, lastError;
  const deadline = Date.now() + 6000;
  for (let attempt = 0; attempt < 50 && Date.now() < deadline; attempt++) {
    try {
      const bridge = await connectSharedBridge({ port, installationToken, timeoutMs });
      diagnostics?.record('info', 'shared_bridge_connected');
      return bridge;
    } catch (error) {
      lastError = error;
      if (!['ECONNREFUSED', 'ECONNRESET', 'BRIDGE_DISCONNECTED', 'BRIDGE_VERSION_MISMATCH'].includes(error.code)) throw error;
      if (!launched && error.code === 'ECONNREFUSED') {
        launched = true;
        const child = spawn(process.execPath, [entry, '--bridge-worker'], { detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, FIGMA_BRIDGE_PORT: String(port), FIGMA_BRIDGE_TIMEOUT_MS: String(timeoutMs) } });
        child.on('error', error => { spawnError = error; }); child.unref();
      }
      if (spawnError) throw spawnError;
      // Older workers reset their idle timer even for rejected clients. Leave
      // their three-second shutdown window quiet before checking the port again.
      const pause = error.code === 'BRIDGE_VERSION_MISMATCH' ? 3300 : 100;
      await delay(Math.min(pause, Math.max(0, deadline - Date.now())));
    }
  }
  throw lastError ?? new Error('Shared bridge did not start. Read local diagnostics; no existing process was stopped.');
}
