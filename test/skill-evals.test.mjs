import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, realpath, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';

// Dataset integrity only: this does not execute prompts or grade agent behavior.
test('behavioral evals have unique IDs, judgeable expectations and portable fixture references', async () => {
  const root = fileURLToPath(new URL('../skills/figma-local-design/', import.meta.url));
  const text = z.string().trim().min(1);
  const data = z.object({ skill_name: z.literal('figma-local-design'), evals: z.array(z.object({
    id: z.number().int().positive(), prompt: text, expected_output: text,
    expectations: z.array(text).min(1), files: z.array(text).optional(),
  }).strict()).min(1) }).strict().parse(JSON.parse(await readFile(resolve(root, 'evals/evals.json'), 'utf8')));
  assert.equal(new Set(data.evals.map(item => item.id)).size, data.evals.length);
  assert.equal(new Set(data.evals.map(item => item.prompt)).size, data.evals.length);
  for (const item of data.evals) {
    assert.equal(new Set(item.expectations).size, item.expectations.length, `duplicate expectations in ${item.id}`);
    for (const file of item.files ?? []) {
      assert.ok(!isAbsolute(file) && !file.includes('\\') && !file.includes(':') && !file.split('/').includes('..'));
      const path = await realpath(resolve(root, 'evals', file));
      const rel = relative(await realpath(root), path);
      assert.ok(rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
      assert.ok((await stat(path)).isFile());
    }
  }
});
