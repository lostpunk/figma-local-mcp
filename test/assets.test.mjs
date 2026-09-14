import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareAsset, validateSvg } from '../src/assets.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6tGQAAAAASUVORK5CYII=', 'base64');
test('local asset bytes reach the plugin without local paths; sources and sizes are bounded', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'figma-assets-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'photo.png'); await writeFile(path, png);
  const image = await prepareAsset('import_image', { filePath: path, name: 'Photo' });
  assert.equal(image.filePath, undefined); assert.equal(image.dataBase64, png.toString('base64'));
  await assert.rejects(prepareAsset('import_image', { filePath: path, dataBase64: image.dataBase64 }), /exactly one/);
  await assert.rejects(prepareAsset('import_image', { filePath: 'photo.png' }), /absolute/);
  await assert.rejects(prepareAsset('import_image', { filePath: dir }), /regular file/);
  await writeFile(path, Buffer.alloc(8 * 1024 * 1024 + 1));
  await assert.rejects(prepareAsset('import_image', { filePath: path }), /at most/);
  await assert.rejects(prepareAsset('import_image', { dataBase64: 'not base64!' }), /canonical/);
  await assert.rejects(prepareAsset('import_image', { dataBase64: Buffer.from('secret text').toString('base64') }), /formats/);
  await assert.rejects(prepareAsset('import_image', { nodeId: '1:1', width: 100, dataBase64: image.dataBase64 }), /omit parent/);
});

test('SVG permits vector shapes/local gradients and rejects malformed XML and active/external content', () => {
  const valid = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><defs><linearGradient id="paint"><stop offset="0" stop-color="#fff"/></linearGradient></defs><path fill="url(#paint)" d="M0 0L24 24"/></svg>';
  assert.equal(validateSvg(valid), valid);
  for (const svg of ['<svg><path></svg>', '<!DOCTYPE svg><svg/>', '<svg><script/></svg>',
    '<svg><foreignObject/></svg>', '<svg onload="foo()"/>', '<svg><image href="https://example.com/a.png"/></svg>',
    '<svg><use href="https://example.com/icon.svg#x"/></svg>', '<svg><use href="&#104;ttps://example.com/x"/></svg>',
    '<svg><path style="fill:url(https://example.com/x)"/></svg>', '<svg><style>@import "x";</style></svg>',
    '<svg><?xml-stylesheet href="x"?></svg>', '<html/>', '<svg>'+ '<g>'.repeat(65)+'</g>'.repeat(65)+'</svg>']) {
    assert.throws(() => validateSvg(svg), undefined, svg.slice(0, 80));
  }
});

test('SVG file and inline data use the same validation path', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'figma-svg-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'icon.svg'); const svg = '<svg><path d="M0 0L10 10"/></svg>';
  await writeFile(path, svg);
  assert.deepEqual(await prepareAsset('import_svg', { filePath: path }), { svg });
  assert.deepEqual(await prepareAsset('import_svg', { svg }), { svg });
  await assert.rejects(prepareAsset('import_svg', { svg, filePath: path }), /exactly one/);
});
