import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, realpath, rm, symlink, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { exportAssets, decodeExport, MAX_ASSET_BYTES } from '../src/asset-export.mjs';
import { readAssetAccess, updateAssetAccess } from '../src/asset-access.mjs';
import { pluginHarness } from './plugin-harness.mjs';

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0L1 1"/></svg>');
const payload = (bytes = svg, extra = {}) => ({ sourceSession: 'session-one', byteLength: bytes.length, dataBase64: bytes.toString('base64'), ...extra });
const nodeSource = (format = 'SVG') => ({ kind: 'node', nodeId: '1:2', format });
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'figma export $ space-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = join(root, 'assets'), outside = join(root, 'assets-other');
  await mkdir(output); await mkdir(outside);
  const run = (items, request = async () => payload(), outputDirectory = output) => exportAssets({ packageRoot: root, args: { outputDirectory, items }, request });
  return { root, output, outside, run };
}

test('exports require separate permission; legacy import permission does not grant writes', async t => {
  const f = await fixture(t);
  let calls = 0;
  const request = async () => { calls++; return payload(); };
  await updateAssetAccess(f.root, 'allow', f.output);
  await assert.rejects(f.run([nodeSource()], request), /export is disabled/);
  assert.equal(calls, 0);
  assert.deepEqual(await readdir(f.output), []);
  await updateAssetAccess(f.root, 'allow-export', f.output);
  assert.deepEqual((await readAssetAccess(f.root)).allowedExportRoots, [f.output]);
  await updateAssetAccess(f.root, 'clear');
  assert.deepEqual((await readAssetAccess(f.root)).allowedExportRoots, [f.output]);
  assert.equal((await f.run([nodeSource()])).status, 'completed');
  await updateAssetAccess(f.root, 'clear-export');
  await assert.rejects(f.run([nodeSource()]), /disabled/);
});

test('source and rendered assets save intact bytes, per-item formats and a recoverable manifest', async t => {
  const f = await fixture(t);
  await updateAssetAccess(f.root, 'allow-export', f.output);
  const calls = [];
  const result = await f.run([{ ...nodeSource(), name: 'logo' }, { kind: 'image', imageHash: 'original' }], async args => {
    calls.push(args);
    return payload(args.source.kind === 'image' ? png : svg);
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.manifestError, false);
  assert.deepEqual(result.entries.map(e => e.filename), ['001-logo.svg', '002-asset.png']);
  assert.deepEqual(await readFile(result.entries[1].path), png);
  assert.equal(result.entries[1].sha256.length, 64);
  assert.equal(calls[0].sourceSession, undefined);
  assert.equal(calls[1].sourceSession, 'session-one');
  assert.equal(calls[0].source.name, undefined, 'local filenames are not sent to Figma');
  assert.ok(!JSON.stringify(calls).includes(f.output));
  const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'));
  assert.equal(manifest.status, 'completed');
  assert.equal(manifest.totalBytes, png.length + svg.length);
  assert.ok(!JSON.stringify(result).includes('dataBase64'));
});

test('repeated calls and duplicate item names never overwrite existing files', async t => {
  const f = await fixture(t);
  await updateAssetAccess(f.root, 'allow-export', f.output);
  await writeFile(join(f.output, '001-logo.svg'), 'existing');
  const items = [{ ...nodeSource(), name: 'logo' }, { ...nodeSource(), name: 'logo' }];
  const first = await f.run(items), second = await f.run(items);
  assert.notEqual(first.directory, second.directory);
  assert.notEqual(first.entries[0].path, first.entries[1].path);
  assert.equal(await readFile(join(f.output, '001-logo.svg'), 'utf8'), 'existing');
});

test('sibling paths, traversal names and escaping directory links are rejected before export', async t => {
  const f = await fixture(t);
  await updateAssetAccess(f.root, 'allow-export', f.output);
  await symlink(f.outside, join(f.output, 'escape'), 'junction');
  for (const destination of [f.outside, join(f.output, 'escape'), join(f.output, '..', 'assets-other')])
    await assert.rejects(f.run([nodeSource()], undefined, destination), /outside/);
  for (const name of ['../escape', 'x/y', 'x\\y', 'CON:', '<script>'])
    await assert.rejects(f.run([{ ...nodeSource(), name }]));
  await assert.rejects(f.run([nodeSource()], undefined, 'relative'), /absolute/);
  assert.deepEqual(await readdir(f.outside), []);
});

test('batch keeps successful resources and records failures without arbitrary plugin error text', async t => {
  const f = await fixture(t); await updateAssetAccess(f.root, 'allow-export', f.output);
  let index = 0;
  const result = await f.run([nodeSource(), nodeSource(), nodeSource()], async () => {
    index++;
    return index === 2 ? { sourceSession: 'session-one', error: 'private design text' } : payload();
  });
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.entries.map(e => e.status), ['saved', 'failed', 'saved']);
  assert.equal(result.entries[1].error, 'ASSET_EXPORT_FAILED');
  assert.ok(!JSON.stringify(result).includes('private design text'));
  assert.deepEqual(result.unprocessedIndices, []);
});

test('source session change or transport interruption stops the batch without automatic retry', async t => {
  const f = await fixture(t); await updateAssetAccess(f.root, 'allow-export', f.output);
  for (const mode of ['different-session', 'timeout']) {
    let calls = 0;
    const result = await f.run([nodeSource(), nodeSource(), nodeSource()], async () => {
      if (++calls === 2) {
        if (mode === 'timeout') throw new Error('timed out');
        return payload(svg, { sourceSession: 'another-file' });
      }
      return payload();
    });
    assert.equal(result.status, 'partial');
    assert.equal(calls, 2);
    assert.deepEqual(result.unprocessedIndices, [1, 2]);
    assert.equal(result.entries.length, 1);
    assert.equal(result.stoppedReason, mode === 'timeout' ? 'SOURCE_UNAVAILABLE' : 'SOURCE_CHANGED');
    assert.equal(JSON.parse(await readFile(result.manifestPath)).status, 'partial');
  }
});

test('revoked export permission prevents saving returned bytes and reports stale manifest', async t => {
  const f = await fixture(t); await updateAssetAccess(f.root, 'allow-export', f.output);
  const result = await f.run([nodeSource()], async () => {
    await updateAssetAccess(f.root, 'clear-export');
    return payload();
  });
  assert.equal(result.stoppedReason, 'DESTINATION_UNAVAILABLE');
  assert.equal(result.manifestError, true);
  assert.deepEqual((await readdir(result.directory)).filter(name => name.endsWith('.svg')), []);
});

test('replaced output directory cannot redirect exported files to an unrelated directory', async t => {
  const f = await fixture(t); await updateAssetAccess(f.root, 'allow-export', f.output);
  const result = await f.run([nodeSource()], async () => {
    await rename(f.output, join(f.root, 'old-assets'));
    await symlink(f.outside, f.output, 'junction');
    return payload();
  });
  assert.equal(result.stoppedReason, 'DESTINATION_UNAVAILABLE');
  assert.deepEqual(await readdir(f.outside), []);
});

test('export payloads validate canonical base64, exact size and source format', () => {
  for (const result of [payload(svg, { byteLength: 1 }), payload(svg, { dataBase64: 'bad!' }), payload(Buffer.from('unknown')),
    payload(svg, { scale: -1 })]) assert.throws(() => decodeExport(result, nodeSource()));
  assert.throws(() => decodeExport(payload(png), nodeSource()));
  assert.throws(() => decodeExport(payload(svg), { kind: 'image' }));
  assert.equal(decodeExport(payload(Buffer.from('<svg/>')), nodeSource()).extension, 'svg');
  assert.equal(decodeExport(payload(Buffer.from('<?xml version="1.0"?>\n<svg/>')), nodeSource()).extension, 'svg');
  assert.deepEqual(decodeExport(payload(Buffer.from('%PDF-1.7')), nodeSource('PDF')).extension, 'pdf');
  assert.deepEqual(decodeExport(payload(Buffer.from('GIF89adata')), { kind: 'image' }).extension, 'gif');
  assert.deepEqual(decodeExport(payload(Buffer.from('RIFFxxxxWEBPdata')), { kind: 'image' }).extension, 'webp');
  assert.throws(() => decodeExport(payload(Buffer.alloc(MAX_ASSET_BYTES + 1)), nodeSource('PNG')), /size|bytes/);
});

test('aggregate byte cap stops before writing an asset that would exceed it', async t => {
  const f = await fixture(t); await updateAssetAccess(f.root, 'allow-export', f.output);
  const bytes = Buffer.alloc(MAX_ASSET_BYTES); png.copy(bytes);
  const result = await f.run(Array.from({ length: 10 }, () => nodeSource('PNG')), async () => payload(bytes));
  assert.equal(result.stoppedReason, 'BATCH_SIZE_LIMIT');
  assert.equal(result.entries.length, 8);
  assert.deepEqual(result.unprocessedIndices, [8, 9]);
  assert.equal(result.totalBytes, 64 * 1024 * 1024);
});

test('plugin exports requested formats, caps raster scale and never changes the scene', async () => {
  const h = pluginHarness(), node = h.figma.createRectangle();
  node.absoluteBoundingBox = { x: 0, y: 0, width: 8192, height: 400 };
  const settings = [];
  node.exportAsync = async args => { settings.push(args); return new Uint8Array(png); };
  for (const format of ['PNG', 'JPG', 'SVG', 'PDF']) {
    const result = await h.call('export_asset', { source: { kind: 'node', nodeId: node.id, format, scale: 2 } });
    assert.equal(result.error, undefined);
    assert.equal(result.result.byteLength, png.length);
    assert.equal(result.result.scale, ['PNG', 'JPG'].includes(format) ? 0.5 : undefined);
  }
  assert.deepEqual(settings.map(s => s.format), ['PNG', 'JPG', 'SVG', 'PDF']);
  assert.equal(settings[2].svgOutlineText, true);
  assert.equal(node.width, 100);
  assert.equal(h.undoCount, 0);
});

test('plugin retrieves original stored bytes and distinguishes missing or inaccessible images', async () => {
  const h = pluginHarness();
  h.figma.getImageByHash = hash => hash === 'missing' ? null : { async getBytesAsync() {
    if (hash === 'offline') throw new Error('private source detail');
    return new Uint8Array(png);
  } };
  for (const [imageHash, error] of [['original', undefined], ['missing', 'IMAGE_NOT_FOUND'], ['offline', 'IMAGE_BYTES_UNAVAILABLE']]) {
    const result = await h.call('export_asset', { source: { kind: 'image', imageHash } });
    assert.equal(result.result.error, error);
    if (!error) assert.deepEqual(Buffer.from(result.result.dataBase64, 'base64'), png);
  }
  h.figma.getImageByHash = () => { throw new Error('image lookup failed'); };
  assert.equal((await h.call('export_asset', { source: { kind: 'image', imageHash: 'unavailable' } })).result.error, 'IMAGE_BYTES_UNAVAILABLE');
});

test('plugin session pin rejects a restarted plugin before exporting a same-ID node', async () => {
  const h = pluginHarness(), other = pluginHarness();
  const node = h.figma.createRectangle(), sameId = other.figma.createRectangle();
  const first = await h.call('export_asset', { source: { kind: 'node', nodeId: node.id, format: 'PNG' } });
  let calls = 0;
  sameId.exportAsync = async () => { calls++; return new Uint8Array(png); };
  const result = await other.call('export_asset', { source: { kind: 'node', nodeId: sameId.id, format: 'PNG' }, sourceSession: first.result.sourceSession });
  assert.match(result.error, /EXPORT_SOURCE_CHANGED/);
  assert.equal(calls, 0);
});

test('plugin reports unsupported, oversized and failed exports without leaking source details', async () => {
  const h = pluginHarness();
  const node = h.figma.createRectangle();
  assert.equal((await h.call('export_asset', { source: { kind: 'node', nodeId: h.page.id, format: 'PDF' } })).result.error, 'SCENE_EXPORT_REQUIRED');
  node.exportAsync = async () => { throw new Error('private name'); };
  assert.equal((await h.call('export_asset', { source: { kind: 'node', nodeId: node.id, format: 'SVG' } })).result.error, 'NODE_EXPORT_FAILED');
  node.exportAsync = async () => new Uint8Array(MAX_ASSET_BYTES + 1);
  assert.equal((await h.call('export_asset', { source: { kind: 'node', nodeId: node.id, format: 'SVG' } })).result.error, 'ASSET_SIZE_LIMIT');
  assert.match((await h.call('export_asset', { source: { kind: 'node', nodeId: node.id, format: 'MP4' } })).error, /Invalid/);
});
