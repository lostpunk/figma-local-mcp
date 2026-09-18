import { createHash, randomUUID } from 'node:crypto';
import { historyRetention } from './operation-history.mjs';
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
// Each boot gets a fresh namespace: even lost/evicted journal entries cannot replay old writes.
export function createOperations({ maxEntries = 100, maxBytes = 16 * 1024 * 1024, history, now = Date.now } = {}) {
  const sessionId = randomUUID();
  let sequence = 0;
  const records = new Map();
  let historyFault = false;
  for (const record of history?.load() ?? []) {
    if (['running', 'waiting_result'].includes(record.status)) record.status = 'unknown';
    record.historical = true;
    if (record.result !== undefined) record.resultBytes = Buffer.byteLength(JSON.stringify(record.result));
    records.set(record.id, record);
  }
  trim();
  function persist(required = false) {
    if (!history) return true;
    if (historyFault) { if (required) throw new Error('Operation history is unavailable; no edit dispatched. Restart after repairing local storage.'); return false; }
    try { history.save(records.values()); return true; }
    catch {
      historyFault = true;
      if (required) throw new Error('Cannot persist operation history; no edit dispatched. Check local disk space and permissions.');
      return false;
    }
  }
  const nextId = () => `${sessionId}:${sequence + 1}`;
  const hash = (command, args) => createHash('sha256').update(JSON.stringify(canonical({ command, args }))).digest('hex');
  function lookup(id) {
    trim();
    const record = records.get(id);
    if (record) return record;
    const [session, number, extra] = String(id).split(':');
    if (session !== sessionId) throw new Error('Operation belongs to another server session. Inspect the file; do not replay the edit.');
    if (extra !== undefined || !/^[1-9]\d*$/.test(number ?? '') || !Number.isSafeInteger(Number(number))) throw new Error('Invalid operation ID');
    if (Number(number) <= sequence) throw new Error('Operation result expired. Inspect the file; this ID cannot be executed again.');
    throw new Error('Operation has not been dispatched');
  }
  function existing(id, command, args) {
    if (id === nextId()) return;
    const record = lookup(id);
    if (record.fingerprint !== hash(command, args)) throw new Error('Operation ID was already used with different arguments');
    return record;
  }
  function start(id, command, args, pluginSessionId) {
    if (id !== nextId()) throw new Error('Use nextOperationId from get_connection for a new edit');
    if (typeof command !== 'string' || !/^[a-z_]{1,100}$/.test(command)) throw new Error('Invalid operation command');
    sequence++;
    const record = { id, command, pluginSessionId, status: 'running', startedAt: now(), fingerprint: hash(command, args) };
    records.set(id, record); trim();
    try { persist(true); }
    catch (error) {
      record.status = 'failed'; record.finishedAt = Math.max(record.startedAt, now());
      record.error = 'Operation was not dispatched because local history could not be persisted.';
      throw error;
    }
    return record;
  }
  function trim() {
    for (const [id, r] of records) if (!['running', 'waiting_result'].includes(r.status) && now() - r.startedAt >= historyRetention.maxAgeMs) records.delete(id);
    let bytes = 0;
    for (const r of [...records.values()].reverse()) {
      bytes += r.resultBytes ?? 0;
      if (bytes > maxBytes && r.result !== undefined) { delete r.result; r.resultExpired = true; r.resultBytes = 0; }
    }
    while (records.size > maxEntries) records.delete(records.keys().next().value);
  }
  function finish(id, message) {
    const r = records.get(id); if (!r) return;
    r.status = typeof message.error === 'string' ? 'failed' : 'completed'; r.finishedAt = Math.max(r.startedAt, now());
    if (r.status === 'failed') r.error = message.error.slice(0, 4000);
    else { r.result = message.result; r.resultBytes = Buffer.byteLength(JSON.stringify(message.result ?? null)); }
    trim(); return persist();
  }
  function mark(id, status) { const record = records.get(id); if (record) { record.status = status; return persist(); } return true; }
  function view(id) {
    const r = lookup(id);
    return { operationId: r.id, command: r.command, status: r.status, historical: Boolean(r.historical), elapsedMs: Math.max(0, (r.finishedAt ?? now()) - r.startedAt),
      ...(r.resultExpired ? { resultExpired: true } : r.status === 'completed' ? { result: r.result } : {}), ...(r.error ? { error: r.error } : {}) };
  }
  function list({ limit = 20 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Operation history limit must be 1–100');
    trim();
    const entries = [...records.values()].reverse().slice(0, limit).map(r => ({ operationId: r.id, command: r.command,
      status: r.status, startedAt: r.startedAt, ...(r.finishedAt ? { finishedAt: r.finishedAt } : {}),
      historical: Boolean(r.historical), resultAvailable: r.status === 'completed' && !r.resultExpired }));
    return { entries, truncated: records.size > limit, history: info() };
  }
  function info() { return { mode: history ? 'encrypted_local' : 'memory', healthy: !historyFault, retention: historyRetention }; }
  return { sessionId, nextId, existing, start, finish, mark, view, lookup, list, info };
}
