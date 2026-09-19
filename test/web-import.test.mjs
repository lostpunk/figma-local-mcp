import test from 'node:test';
import assert from 'node:assert/strict';
import { pluginHarness } from './plugin-harness.mjs';
import { webSnapshotSchema } from '../src/web-snapshot-schema.mjs';
import { snapshot, row } from './web-import-fixture.mjs';
const harness = () => {
  const h = pluginHarness();
  h.figma.listAvailableFontsAsync = async () => [{ fontName: { family: 'Inter', style: 'Regular' } }];
  return h;
};
const call = async (h, args) => { const r = await h.call('import_web_snapshot', args); assert.equal(r.error, undefined); return r.result; };

test('web preview is read-only; apply preserves geometry, literal text, transparency and images', async () => {
  const h = harness(), data = snapshot(), before = h.nodes.size;
  const plan = await call(h, { snapshot: data, x: 200, y: 300 });
  assert.equal(plan.dryRun, true); assert.equal(plan.visualVerification, 'pending');
  assert.equal(h.nodes.size, before); assert.equal(h.fonts.length, 0); assert.equal(h.undoCount, 0);
  const done = await call(h, { snapshot: data, x: 200, y: 300, dryRun: false, revision: plan.revision });
  const root = h.nodes.get(done.rootId), text = h.nodes.get(done.nodes[1].id), image = h.nodes.get(done.nodes[2].id);
  assert.equal(root.x, 200); assert.equal(root.y, 300);
  assert.equal(text.parent, root); assert.equal(text.x, 16); assert.equal(text.y, 16);
  assert.equal(text.characters, 'Hello <script>'); assert.equal(text.fills[0].opacity, 0.8);
  assert.equal(image.fills[0].type, 'IMAGE'); assert.equal(image.fills[0].scaleMode, 'FIT');
  assert.equal(h.undoCount, 1);
});

test('snapshot schema refuses duplicate IDs, bad parents, executable extras, oversized images and invalid geometry', () => {
  for (const change of [
    d => { d.nodes[1].ref = 'n0'; }, d => { d.nodes[1].parentRef = 'n2'; },
    d => { d.nodes[2].parentRef = 'n1'; }, d => { d.nodes[0].x = 4; },
    d => { d.nodes[1].font.size = Infinity; }, d => { d.nodes[1].text = 'x'.repeat(2001); },
    d => { d.nodes[2].imageRef = 'n77'; }, d => { d.nodes[0].script = 'alert(1)'; },
    d => { d.images[0].png = 'https://example.com/asset.png'; },
    d => { d.nodes[0].radii = [0, 0, 0]; }, d => { d.nodes[0].radii = [0, 0, 0, 0, 0]; },
    d => { d.nodes[0].textLayout = 'SINGLE_LINE'; },
    d => { d.nodes[1].textLayout = 'SINGLE_LINE'; d.nodes[1].text = 'Two\nlines'; },
    d => { d.nodes.push(...Array.from({ length: 201 }, (_, i) => row({ ref: `n${i + 3}`, parentRef: 'n0' }))); },
  ]) { const d = snapshot(); change(d); assert.equal(webSnapshotSchema.safeParse(d).success, false); }
});

test('single-line browser text uses natural width; wrapped and legacy text keep their captured box', async () => {
  const h = harness(), d = snapshot(), original = h.figma.createText;
  h.figma.createText = () => {
    const node = original(); let mode = 'NONE';
    Object.defineProperty(node, 'textAutoResize', { configurable: true, get: () => mode, set(value) {
      mode = value;
      if (value === 'WIDTH_AND_HEIGHT') { node.width = 101.25; node.height = 28; }
    } });
    return node;
  };
  d.nodes[1].textLayout = 'SINGLE_LINE';
  const p = await call(h, { snapshot: d });
  const done = await call(h, { snapshot: d, dryRun: false, revision: p.revision });
  const n = h.nodes.get(done.nodes[1].id);
  assert.equal(n.textAutoResize, 'WIDTH_AND_HEIGHT'); assert.equal(n.width, 101.25);
  assert.equal(n.x, 16); assert.equal(n.y, 14);
  assert.ok(done.warnings.some(w => w.code === 'text_metrics_adjusted'));
  d.nodes[0].layout = { direction: 'VERTICAL', gap: 10, padding: [16, 16, 16, 16], justify: 'MIN', align: 'MIN' };
  const flexPlan = await call(h, { snapshot: d });
  const flex = await call(h, { snapshot: d, dryRun: false, revision: flexPlan.revision });
  const flexText = h.nodes.get(flex.nodes[1].id);
  assert.equal(flex.autoLayoutCount, 0);
  assert.ok(flex.warnings.some(w => w.code === 'auto_layout_fallback_to_coordinates'));
  assert.equal(flexText.textAutoResize, 'WIDTH_AND_HEIGHT'); assert.equal(flexText.width, 101.25); assert.equal(flexText.y, 14);
  delete d.nodes[0].layout;
  for (const layout of ['WRAPPED', undefined]) {
    d.nodes[1].textLayout = layout;
    const plan = await call(h, { snapshot: d });
    const result = await call(h, { snapshot: d, dryRun: false, revision: plan.revision });
    const text = h.nodes.get(result.nodes[1].id);
    assert.equal(text.textAutoResize, 'NONE'); assert.equal(text.width, 100); assert.equal(text.y, 16);
  }
});

test('stale snapshot, destination, font availability and plugin-session changes require a new preview', async () => {
  const h = harness(), data = snapshot(), plan = await call(h, { snapshot: data });
  assert.match((await h.call('import_web_snapshot', { snapshot: data, dryRun: false })).error, /WEB_PREVIEW_CHANGED/);
  const changed = snapshot(); changed.nodes[1].text = 'Changed';
  assert.match((await h.call('import_web_snapshot', { snapshot: changed, dryRun: false, revision: plan.revision })).error, /WEB_PREVIEW_CHANGED/);
  assert.match((await h.call('import_web_snapshot', { snapshot: data, x: 1, dryRun: false, revision: plan.revision })).error, /WEB_PREVIEW_CHANGED/);
  const other = harness();
  assert.match((await other.call('import_web_snapshot', { snapshot: data, dryRun: false, revision: plan.revision })).error, /WEB_PREVIEW_CHANGED/);
  assert.equal(h.undoCount, 0);
});

test('missing fonts and image pixels are reported; font load failure happens before any layer creation', async () => {
  const h = harness(), data = snapshot(); data.nodes[1].font.family = 'Missing Font'; delete data.nodes[2].imageRef; data.images = [];
  const plan = await call(h, { snapshot: data });
  assert.ok(plan.warnings.some(w => w.code === 'font_substituted_with_inter_regular'));
  assert.ok(plan.warnings.some(w => w.code === 'image_placeholder'));
  const before = h.nodes.size;
  h.figma.loadFontAsync = async () => { throw new Error('Font unavailable'); };
  assert.match((await h.call('import_web_snapshot', { snapshot: data, dryRun: false, revision: plan.revision })).error, /Font unavailable/);
  assert.equal(h.nodes.size, before);
  h.figma.listAvailableFontsAsync = async () => [];
  assert.match((await h.call('import_web_snapshot', { snapshot: data })).error, /WEB_FONT_UNAVAILABLE/);
});

test('malformed or excessive PNG dimensions and an Auto Layout destination fail before writes', async () => {
  const h = harness(), d = snapshot();
  const bytes = Buffer.from(d.images[0].png, 'base64'); bytes.writeUInt32BE(10000, 16); d.images[0].png = bytes.toString('base64');
  assert.match((await h.call('import_web_snapshot', { snapshot: d })).error, /PNG exceeds/);
  const frame = h.node('FRAME', 'Existing', h.page); frame.layoutMode = 'HORIZONTAL';
  assert.match((await h.call('import_web_snapshot', { snapshot: snapshot(), parentId: frame.id })).error, /without Auto Layout/);
  assert.equal(h.undoCount, 0);
});

test('later creation failure removes only imported layers and reports failed cleanup', async () => {
  const h = harness(), d = snapshot(), plan = await call(h, { snapshot: d });
  const before = h.nodes.size;
  h.figma.createText = () => { throw new Error('Create failed'); };
  assert.match((await h.call('import_web_snapshot', { snapshot: d, dryRun: false, revision: plan.revision })).error, /New layers removed/);
  assert.equal(h.nodes.size, before); assert.equal(h.undoCount, 0);
  const original = h.figma.createFrame;
  h.figma.createFrame = () => { const n = original(); n.remove = () => { throw new Error('Cannot remove'); }; return n; };
  assert.match((await h.call('import_web_snapshot', { snapshot: d, dryRun: false, revision: plan.revision })).error, /Cleanup incomplete/);
});

test('simple Auto Layout is retained only when child geometry matches the source', async () => {
  const h = harness(), d = snapshot();
  d.nodes[0].layout = { direction: 'VERTICAL', gap: 10, padding: [16, 16, 16, 16], justify: 'MIN', align: 'MIN' };
  const p = await call(h, { snapshot: d });
  const good = await call(h, { snapshot: d, dryRun: false, revision: p.revision });
  assert.equal(good.autoLayoutCount, 1);
  const original = h.figma.createFrame;
  h.figma.createFrame = () => {
    const node = original(); let mode = 'NONE';
    Object.defineProperty(node, 'layoutMode', { get: () => mode, set(value) { mode = value; if (value !== 'NONE') for (const child of node.children) child.x += 40; } });
    return node;
  };
  const fallback = await call(h, { snapshot: d, dryRun: false, revision: p.revision });
  assert.equal(fallback.autoLayoutCount, 0);
  assert.ok(fallback.warnings.some(w => w.code === 'auto_layout_fallback_to_coordinates'));
  const root = h.nodes.get(fallback.rootId); assert.equal(root.layoutMode, 'NONE'); assert.equal(root.children[0].x, 16);
});

test('aggregate decoded image pixels are bounded even when compressed bytes are small', async () => {
  const h = harness(), d = snapshot();
  const bytes = Buffer.from(d.images[0].png, 'base64'); bytes.writeUInt32BE(4096, 16); bytes.writeUInt32BE(4096, 20);
  d.images = [{ ref: 'n2', png: bytes.toString('base64') }, { ref: 'n3', png: bytes.toString('base64') }];
  const before = h.nodes.size;
  assert.match((await h.call('import_web_snapshot', { snapshot: d })).error, /16 megapixel/);
  assert.equal(h.nodes.size, before);
});

test('snapshot file import requires an allowed local path and the same strict schema', async t => {
  const { mkdtemp, writeFile, rm, realpath } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { prepareAsset } = await import('../src/assets.mjs');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'web-import-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = join(root, 'snapshot.json'); await writeFile(filePath, JSON.stringify(snapshot()));
  await assert.rejects(prepareAsset('import_web_snapshot', { filePath }, []));
  const result = await prepareAsset('import_web_snapshot', { filePath, dryRun: true }, [root]);
  assert.equal(result.filePath, undefined); assert.equal(result.snapshot.nodes.length, 3);
  await assert.rejects(prepareAsset('import_web_snapshot', { filePath, snapshot: snapshot() }, [root]), /exactly one/);
  await assert.rejects(prepareAsset('import_web_snapshot', {}, [root]), /exactly one/);
  await writeFile(filePath, JSON.stringify({ ...snapshot(), secret: 'unexpected' }));
  await assert.rejects(prepareAsset('import_web_snapshot', { filePath }, [root]), /Unrecognized/);
});
