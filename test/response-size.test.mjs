import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

// Execute the same browser-safe implementation without TextEncoder or Node APIs.
const bundled = await build({
  entryPoints: [fileURLToPath(new URL('../plugin/response-size.ts', import.meta.url))],
  bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2017',
});
const { jsonBytes } = await import('data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64'));

test('shared response sizing matches actual UTF-8 JSON bytes, including escaped surrogates', () => {
  for (const value of [null, {}, [], 42, 'ASCII', 'Кириллица', '日本語', '👕🧵', '\ud800', '\udfff',
    { text: '\u0000\n"\\', absent: undefined }, { nodes: [{ name: 'Магазин 👕'.repeat(5000) }] }]) {
    assert.equal(jsonBytes(value), Buffer.byteLength(JSON.stringify(value), 'utf8'));
  }
});
