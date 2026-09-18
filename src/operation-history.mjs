import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { closeSync, constants, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

export const historyRetention = { maxEntries: 100, maxResultBytes: 1024 * 1024, maxTotalBytes: 4 * 1024 * 1024, maxAgeMs: 7 * 86400000 };
const maxFileBytes = 8 * 1024 * 1024;
const aad = Buffer.from('figma-local-operation-history-v1');
const statuses = new Set(['running', 'waiting_result', 'unknown', 'completed', 'failed']);
const idPattern = /^[a-f0-9-]{36}:[1-9]\d*$/;
function safeDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Operation history directory must not be a symlink');
  if (process.platform !== 'win32') chmodSync(path, 0o700);
}
function checkFile(path) {
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > maxFileBytes) throw new Error('Invalid operation history file');
    return true;
  } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

// One writer per port: the bridge must bind its localhost listener BEFORE opening this store.
// Port-isolated checks do not open the real installation's history.
export function createOperationHistory({ directory, port, installationToken, now = Date.now }) {
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !/^[a-f0-9]{64}$/.test(installationToken)) throw new Error('Invalid history configuration');
  safeDirectory(directory);
  const path = join(directory, `port-${port}.enc`);
  const key = createHash('sha256').update(aad).update(Buffer.from(installationToken, 'hex')).digest();
  function load() {
    if (!checkFile(path)) return [];
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let envelope;
    try {
      if (fstatSync(fd).size > maxFileBytes) throw new Error('Operation history is too large');
      envelope = JSON.parse(readFileSync(fd, 'utf8'));
    } finally { closeSync(fd); }
    if (envelope.format !== 1 || typeof envelope.iv !== 'string' || typeof envelope.tag !== 'string' || typeof envelope.data !== 'string') throw new Error('Unsupported operation history format');
    try {
      const iv = Buffer.from(envelope.iv, 'base64'), tag = Buffer.from(envelope.tag, 'base64');
      if (iv.length !== 12 || tag.length !== 16) throw new Error('Invalid encryption parameters');
      const decipher = createDecipheriv('aes-256-gcm', key, iv); decipher.setAAD(aad); decipher.setAuthTag(tag);
      const decoded = Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]);
      if (decoded.length > historyRetention.maxTotalBytes) throw new Error('History exceeds retention size');
      const payload = JSON.parse(decoded.toString('utf8'));
      if (payload.format !== 1 || !Array.isArray(payload.records) || payload.records.length > historyRetention.maxEntries) throw new Error('Invalid history records');
      const ids = new Set();
      for (const r of payload.records) {
        if (!r || typeof r.id !== 'string' || !idPattern.test(r.id) || ids.has(r.id)
          || typeof r.command !== 'string' || !/^[a-z_]{1,100}$/.test(r.command)
          || !statuses.has(r.status) || !Number.isSafeInteger(r.startedAt) || r.startedAt < 0
          || (r.finishedAt !== undefined && (!Number.isSafeInteger(r.finishedAt) || r.finishedAt < r.startedAt))
          || !/^[a-f0-9]{64}$/.test(r.fingerprint) || (r.pluginSessionId !== undefined && (typeof r.pluginSessionId !== 'string' || r.pluginSessionId.length > 200))
          || (r.error !== undefined && (typeof r.error !== 'string' || r.error.length > 4000))) throw new Error('Invalid history record');
        ids.add(r.id);
      }
      return payload.records.filter(r => now() - r.startedAt < historyRetention.maxAgeMs);
    } catch (error) { throw new Error('Cannot decrypt or validate operation history; keep the file and pairing key for recovery.', { cause: error }); }
  }
  function save(records) {
    const kept = [];
    // Serialize fresh data only; args, credentials and asset bytes are never journal inputs.
    let bytes = 64;
    for (const source of [...records].reverse()) {
      if (kept.length >= historyRetention.maxEntries || now() - source.startedAt >= historyRetention.maxAgeMs) continue;
      const r = { ...source }; delete r.resultBytes; delete r.historical;
      let encoded = JSON.stringify(r);
      if (Buffer.byteLength(encoded) > historyRetention.maxResultBytes || bytes + Buffer.byteLength(encoded) > historyRetention.maxTotalBytes - 1024) {
        delete r.result; r.resultExpired = true; encoded = JSON.stringify(r);
      }
      if (bytes + Buffer.byteLength(encoded) > historyRetention.maxTotalBytes - 1024) continue;
      bytes += Buffer.byteLength(encoded) + 1; kept.unshift(r);
    }
    const plain = Buffer.from(JSON.stringify({ format: 1, records: kept }));
    if (plain.length > historyRetention.maxTotalBytes) throw new Error('Operation history exceeds storage budget');
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(aad);
    const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
    const envelope = JSON.stringify({ format: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64') });
    safeDirectory(directory); checkFile(path);
    const temp = join(directory, `.history-${randomBytes(12).toString('hex')}.tmp`);
    let fd;
    try {
      fd = openSync(temp, 'wx', 0o600); writeFileSync(fd, envelope); fsyncSync(fd); closeSync(fd); fd = undefined;
      renameSync(temp, path);
      // POSIX directory fsync makes the rename durable. Windows has no equivalent directory fd here.
      if (process.platform !== 'win32') { const dir = openSync(directory, 'r'); try { fsyncSync(dir); } finally { closeSync(dir); } }
    } finally { if (fd !== undefined) closeSync(fd); try { unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  }
  return { load, save };
}
