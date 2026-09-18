import { createHash, randomUUID } from 'node:crypto';
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
// Results stay in memory. Monotonic IDs prevent evicted results from being executed again.
export function createOperations({ maxEntries = 100, maxBytes = 16 * 1024 * 1024 } = {}) {
  const sessionId = randomUUID();
  let sequence = 0;
  const records = new Map();
  const nextId = () => `${sessionId}:${sequence + 1}`;
  const hash = (command, args) => createHash('sha256').update(JSON.stringify(canonical({ command, args }))).digest('hex');
  function lookup(id) {
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
    sequence++;
    const record = { id, command, pluginSessionId, status: 'running', startedAt: Date.now(), fingerprint: hash(command, args) };
    records.set(id, record); trim(); return record;
  }
  function trim() {
    let bytes = 0;
    for (const r of [...records.values()].reverse()) {
      bytes += r.resultBytes ?? 0;
      if (bytes > maxBytes && r.result !== undefined) { delete r.result; r.resultExpired = true; r.resultBytes = 0; }
    }
    while (records.size > maxEntries) records.delete(records.keys().next().value);
  }
  function finish(id, message) {
    const r = records.get(id); if (!r) return;
    r.status = typeof message.error === 'string' ? 'failed' : 'completed'; r.finishedAt = Date.now();
    if (r.status === 'failed') r.error = message.error.slice(0, 4000);
    else { r.result = message.result; r.resultBytes = Buffer.byteLength(JSON.stringify(message.result ?? null)); }
    trim();
  }
  function view(id) {
    const r = lookup(id);
    return { operationId: r.id, command: r.command, status: r.status, elapsedMs: (r.finishedAt ?? Date.now()) - r.startedAt,
      ...(r.resultExpired ? { resultExpired: true } : r.status === 'completed' ? { result: r.result } : {}), ...(r.error ? { error: r.error } : {}) };
  }
  return { sessionId, nextId, existing, start, finish, view, lookup };
}
