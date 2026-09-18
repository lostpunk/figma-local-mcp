import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDiagnostics } from '../src/diagnostics.mjs';

async function folder(t) {
  const directory = await mkdtemp(join(tmpdir(), 'figma-diagnostics-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
test('diagnostics retain actionable metadata, redact credentials and never serialize payloads', async t => {
  const directory = await folder(t); const log = createDiagnostics({ directory });
  log.record('error', 'operation_failed', { command: 'create_scene', requestId: 'request-1', durationMs: 30001,
    code: 'TIMEOUT', message: 'token=' + 'a'.repeat(64) + ' /Users/alice/secret.png https://example.test/key',
    args: { characters: 'PRIVATE DESIGN COPY' }, result: { data: 'PRIVATE IMAGE' }, token: 'secret' });
  const raw = await readFile(join(directory, 'events.jsonl'), 'utf8');
  assert.doesNotMatch(raw, /PRIVATE|alice|example|a{64}/);
  const [event] = log.read().entries;
  assert.equal(event.command, 'create_scene'); assert.equal(event.durationMs, 30001);
  assert.equal(event.requestId, 'request-1'); assert.equal(event.code, 'TIMEOUT');
  // Windows access is governed by ACLs, not POSIX permission bits.
  if (process.platform !== 'win32') assert.equal((await stat(join(directory, 'events.jsonl'))).mode & 0o777, 0o600);
  assert.doesNotThrow(() => log.record('info', 'plugin_connected', { pluginVersion: { toString: null } }));
});
test('diagnostics rotate to a bounded set and remain readable across restarts', async t => {
  const directory = await folder(t); const options = { directory, maxBytes: 600, backups: 2 };
  const log = createDiagnostics(options);
  for (let n = 0; n < 30; n++) log.record(n % 2 ? 'error' : 'info', 'sample', { requestId: String(n), message: 'Example failure' });
  const names = await readdir(directory);
  assert.equal(names.length, 3);
  for (const name of names) assert.ok((await stat(join(directory, name))).size <= 600);
  const restarted = createDiagnostics(options);
  assert.equal(restarted.read({ limit: 1 }).entries[0].requestId, '29');
  assert.ok(restarted.read({ errorsOnly: true }).entries.every(e => e.level === 'error'));
});
test('unwritable diagnostics do not fail operations and expose an in-memory fallback', async t => {
  const directory = await folder(t); const obstacle = join(directory, 'file');
  await writeFile(obstacle, 'not a folder');
  const log = createDiagnostics({ directory: obstacle });
  assert.doesNotThrow(() => log.record('error', 'test_failure', { code: 'PLUGIN_ERROR' }));
  const result = log.read();
  assert.ok(result.storageError); assert.equal(result.entries[0].code, 'PLUGIN_ERROR');
});

test('log sessions distinguish concurrent servers and cannot be overridden by event metadata', async t => {
  const directory = await folder(t);
  const first = createDiagnostics({ directory }); const second = createDiagnostics({ directory });
  const a = first.record('info', 'server_starting');
  const b = second.record('error', 'server_start_failed', { code: 'EADDRINUSE', pid: 0, sessionId: a.sessionId });
  const c = first.record('info', 'operation_started');
  assert.equal(a.pid, process.pid); assert.equal(b.pid, process.pid);
  assert.equal(a.sessionId, c.sessionId); assert.notEqual(a.sessionId, b.sessionId);
  assert.deepEqual(first.read().entries.map(e => e.sessionId), [a.sessionId, b.sessionId, a.sessionId]);
});
