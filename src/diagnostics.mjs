import { mkdirSync, appendFileSync, statSync, renameSync, rmSync, readFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export function safeMessage(value) {
  if (value != null && !['string', 'number', 'boolean'].includes(typeof value)) return '[unsupported metadata]';
  return String(value ?? '').slice(0, 8000)
    .replace(/(?:https?|wss?):\/\/[^\s]+/gi, '[url]')
    .replace(/(?:[A-Za-z]:\\|\/(?:Users|home|private|tmp|var)\/)[^\s]+/g, '[path]')
    .replace(/\b(?:token|pairingCode|authorization|password)\s*[:=]\s*\S+/gi, '[secret]')
    .replace(/[A-Za-z0-9+/=_-]{48,}/g, '[redacted]')
    .replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 1000);
}

// Only explicit metadata is written. Never serialize command args, results or documents.
export function createDiagnostics({ directory, maxBytes = 1024 * 1024, backups = 2 } = {}) {
  const file = join(directory, 'events.jsonl');
  const sessionId = randomUUID();
  let storageError;
  const recent = [];
  function record(level, event, fields = {}) {
    const entry = { time: new Date().toISOString(), level, event: safeMessage(event), pid: process.pid, sessionId };
    for (const key of ['requestId', 'command', 'code', 'pluginVersion', 'message', 'outcome']) {
      if (fields[key] !== undefined) entry[key] = safeMessage(fields[key]);
    }
    for (const key of ['durationMs', 'closeCode']) if (Number.isFinite(fields[key])) entry[key] = fields[key];
    recent.push(entry); if (recent.length > 200) recent.shift();
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const line = JSON.stringify(entry) + '\n';
      let size = 0; try { size = statSync(file).size; } catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (size && size + Buffer.byteLength(line) > maxBytes) {
        rmSync(file + '.' + backups, { force: true });
        for (let n = backups - 1; n >= 1; n--) {
          try { renameSync(file + '.' + n, file + '.' + (n + 1)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
        }
        renameSync(file, file + '.1');
      }
      appendFileSync(file, line, { mode: 0o600 });
      chmodSync(file, 0o600);
      storageError = undefined;
    } catch (e) { storageError = { code: e.code ?? 'LOG_WRITE_FAILED', message: 'Cannot persist diagnostics; recent events remain in memory.' }; }
    return entry;
  }
  function read({ limit = 50, errorsOnly = false } = {}) {
    let entries = [];
    try {
      for (let n = backups; n >= 0; n--) {
        const path = file + (n ? '.' + n : '');
        try {
          if (statSync(path).size > maxBytes + 16384) continue;
          for (const line of readFileSync(path, 'utf8').split('\n')) {
            if (!line) continue;
            try { entries.push(JSON.parse(line)); } catch { /* ignore incomplete final lines */ }
          }
        } catch (e) { if (e.code !== 'ENOENT') throw e; }
      }
    } catch { entries = []; }
    if (storageError || !entries.length) entries = recent;
    return { logFile: file, storageError, entries: entries.filter(e => !errorsOnly || ['error', 'warn'].includes(e.level)).slice(-Math.min(200, Math.max(1, limit))),
      retention: { maxBytesPerFile: maxBytes, files: backups + 1 } };
  }
  return { record, read };
}
