import test from 'node:test';
import assert from 'node:assert/strict';
import { createOperations } from '../src/operations.mjs';
import { readiness, VERSION } from '../src/readiness.mjs';

test('operation keys preserve results, bind arguments and never recycle evicted IDs', () => {
  const ops = createOperations({ maxEntries: 2, maxBytes: 100 });
  const id = ops.nextId();
  ops.start(id, 'create_node', { props: { name: 'A', width: 30 } });
  ops.finish(id, { result: { id: '1:1' } });
  assert.equal(ops.existing(id, 'create_node', { props: { width: 30, name: 'A' } }).status, 'completed');
  assert.throws(() => ops.existing(id, 'delete_node', {}), /different arguments/);
  assert.deepEqual(ops.view(id).result, { id: '1:1' });
  for (let n = 0; n < 2; n++) { const next = ops.nextId(); ops.start(next, 'write', {}); ops.finish(next, { result: 'x'.repeat(200) }); }
  assert.throws(() => ops.existing(id, 'create_node', {}), /expired/);
  assert.throws(() => createOperations().existing(id, 'create_node', {}), /another server session/);
});
test('oversized results expire without losing outcome or allowing a retry', () => {
  const ops = createOperations({ maxBytes: 10 });
  const id = ops.nextId(); ops.start(id, 'write', {}); ops.finish(id, { result: 'large result' });
  assert.equal(ops.view(id).status, 'completed');
  assert.equal(ops.view(id).resultExpired, true);
  assert.equal(ops.existing(id, 'write', {}).result, undefined);
});
test('readiness distinguishes missing plugin, version mismatch, busy and unchecked skill', () => {
  assert.equal(readiness({ connected: false, operation: 'idle' }).issues[0].code, 'PLUGIN_DISCONNECTED');
  const base = { connected: true, document: { pluginVersion: VERSION }, operation: 'idle' };
  assert.equal(readiness(base).skillVersionChecked, false);
  assert.equal(readiness({ ...base, skillVersion: VERSION }).ready, true);
  assert.equal(readiness({ ...base, skillVersion: '0.7.3' }).issues[0].code, 'SKILL_VERSION_MISMATCH');
  assert.equal(readiness({ ...base, document: {} }).issues[0].code, 'PLUGIN_VERSION_UNKNOWN');
  assert.equal(readiness({ ...base, document: { pluginVersion: '0.7.3' } }).ready, false);
  assert.equal(readiness({ ...base, operation: 'running' }).ready, false);
});
