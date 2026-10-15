import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import Ajv2020 from 'ajv/dist/2020.js';
import { toolInputSchema } from '../src/tool-schemas.mjs';

test('tools without arguments keep the SDK empty-object semantics', () => {
  const schema = toolInputSchema({});
  assert.equal(schema.additionalProperties, undefined);
  const validate = new Ajv2020({ strict: false }).compile(schema);
  assert.equal(validate({}), true);
  assert.equal(validate([]), false);
});

test('2020-12 discovery preserves bounds, unions, strict objects and record keys', () => {
  const shared = z.string().min(1).max(5);
  const schema = toolInputSchema({
    size: z.number().positive().max(100),
    name: shared, alias: shared.optional(),
    entries: z.array(z.object({ value: z.union([z.boolean(), shared]) }).strict()).min(1).max(2),
    bindings: z.record(z.enum(['width', 'height']), shared.nullable()).optional(),
  });
  const validate = new Ajv2020({ strict: false }).compile(schema);
  const valid = { size: 1, name: 'a', entries: [{ value: true }], bindings: { width: null } };
  assert.equal(validate(valid), true);
  for (const patch of [{ size: 0 }, { size: 101 }, { name: '' }, { alias: 'toolong' },
    { entries: [] }, { entries: [{ value: 1 }] }, { entries: [{ value: true, extra: 1 }] },
    { bindings: { other: 'a' } }]) assert.equal(validate({ ...valid, ...patch }), false, JSON.stringify(patch));
});

test('incompatible tuple schemas fail rather than being relabelled', () => {
  assert.throws(() => toolInputSchema({ position: z.tuple([z.string(), z.number()]) }), /explicit Draft 2020-12 conversion/);
});

test('schema keyword names in properties and default data remain ordinary data', () => {
  const schema = toolInputSchema({ dependencies: z.string(), items: z.array(z.string()).default(['x']) });
  assert.equal(new Ajv2020({ strict: false }).compile(schema)({ dependencies: 'a' }), true);
});
