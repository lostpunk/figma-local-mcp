// Optional browser smoke check. Playwright is a maintainer dependency, never a recipient requirement.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { captureWebPage } from '../src/web-capture.mjs';
import { webSnapshotSchema } from '../src/web-snapshot-schema.mjs';
import { pluginHarness } from '../test/plugin-harness.mjs';
import { png } from '../test/web-import-fixture.mjs';
const args = process.argv.slice(2), options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!['--playwright-module', '--output', '--browser-channel'].includes(args[i]) || !args[i + 1]) throw new Error('Usage: check-web-capture.mjs [--playwright-module PATH] [--output DIRECTORY] [--browser-channel chrome]');
  options[args[i]] = args[i + 1];
}
const { chromium } = createRequire(import.meta.url)(options['--playwright-module'] ?? 'playwright');
const fixture = await readFile(new URL('../test/fixtures/web-capture.html', import.meta.url), 'utf8');
let browser;
const servers = [];
async function listen(handler) {
  const server = createServer(handler); servers.push(server);
  await new Promise((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes); });
  return `http://127.0.0.1:${server.address().port}`;
}
try {
  const imageOrigin = await listen((_req, res) => { res.setHeader('Content-Type', 'image/png'); res.end(Buffer.from(png, 'base64')); });
  const origin = await listen((req, res) => {
    res.setHeader('Content-Type', req.url === '/image.png' ? 'image/png' : 'text/html');
    res.end(req.url === '/image.png' ? Buffer.from(png, 'base64') : fixture.replace('REMOTE_IMAGE', imageOrigin + '/image.png'));
  });
  browser = await chromium.launch({ headless: true, ...(options['--browser-channel'] ? { channel: options['--browser-channel'] } : {}) });
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  await page.route('**/*', route => [origin, imageOrigin].some(o => route.request().url().startsWith(o + '/')) ? route.continue() : route.abort());
  await page.goto(origin, { waitUntil: 'networkidle' });
  const before = await page.content();
  const snapshot = webSnapshotSchema.parse(await page.evaluate(captureWebPage, { selector: '#fixture' }));
  assert.equal(await page.content(), before, 'capture must not change the page DOM');
  const raw = JSON.stringify(snapshot);
  for (const sentinel of ['PASSWORD_SENTINEL', 'FORM_SENTINEL', 'EDITABLE_SENTINEL', 'HIDDEN_SENTINEL', 'SCRIPT_SENTINEL', 'MASKED_SENTINEL', 'http://']) assert.ok(!raw.includes(sentinel), sentinel);
  for (const tag of ['input', 'textarea']) assert.ok(snapshot.nodes.some(n => n.name === tag && n.kind === 'FRAME'), 'form outlines must remain present');
  assert.ok(snapshot.nodes.some(n => n.kind === 'TEXT' && n.text.includes('editable')));
  assert.equal(snapshot.nodes.find(n => n.text === 'Sample shop').textLayout, 'SINGLE_LINE');
  assert.equal(snapshot.nodes.find(n => n.text?.startsWith('This long sentence')).textLayout, 'WRAPPED');
  assert.equal(snapshot.images.length, 1, 'cross-origin pixels must not be bypassed');
  assert.ok(snapshot.warnings.some(w => w.code === 'image_pixels_unavailable'));
  assert.ok(snapshot.warnings.some(w => w.code === 'pseudo_element_omitted'));
  assert.ok(snapshot.nodes.some(n => n.layout));
  const bounded = webSnapshotSchema.parse(await page.evaluate(captureWebPage, { selector: '#fixture', maxNodes: 3 }));
  assert.equal(bounded.nodes.length, 3); assert.equal(bounded.coverage.complete, false);
  const bundled = await readFile(new URL('../skills/figma-local-design/scripts/web-capture.js', import.meta.url), 'utf8');
  const packaged = webSnapshotSchema.parse(await page.evaluate(`${bundled.trim()}({selector:'#fixture'})`));
  assert.deepEqual(packaged, snapshot, 'portable capture script must match the maintained source');
  const h = pluginHarness();
  h.figma.listAvailableFontsAsync = async () => [{ fontName: { family: 'Arial', style: 'Regular' } }, { fontName: { family: 'Arial', style: 'Bold' } }, { fontName: { family: 'Inter', style: 'Regular' } }];
  const preview = await h.call('import_web_snapshot', { snapshot }); assert.equal(preview.error, undefined);
  const applied = await h.call('import_web_snapshot', { snapshot, dryRun: false, revision: preview.result.revision }); assert.equal(applied.error, undefined);
  assert.equal(applied.result.nodes.length, snapshot.nodes.length);
  const visibilityPage = await browser.newPage();
  await visibilityPage.route('**/*', route => route.abort());
  await visibilityPage.setContent(`<main id="root" style="width:600px;height:500px">
    <div style="display:contents"><button id="contents">Buy now</button>Direct contents text</div>
    <div style="height:0;overflow:visible;opacity:0.5"><button id="overflow">Download</button></div>
    <div style="visibility:hidden;background:red"><span>HIDDEN_PARENT_SENTINEL</span><button id="visible" style="visibility:visible">Continue</button></div>
    <img style="visibility:hidden;width:50px;height:50px" alt="HIDDEN_IMAGE_SENTINEL">
    <div style="display:none"><button>DISPLAY_NONE_SENTINEL</button></div>
    <div style="opacity:0"><button>OPACITY_ZERO_SENTINEL</button></div>
    <div contenteditable="true" style="display:contents">EDITABLE_CONTENTS_SENTINEL</div>
    <div style="display:contents;-webkit-text-security:disc">MASKED_CONTENTS_SENTINEL</div>
  </main>`);
  const captureVisibility = async (extra = {}) => webSnapshotSchema.parse(await visibilityPage.evaluate(captureWebPage, { selector: '#root', ...extra }));
  const visibility = await captureVisibility();
  const texts = visibility.nodes.filter(n => n.kind === 'TEXT');
  for (const [id, text] of [['contents', 'Buy now'], ['overflow', 'Download'], ['visible', 'Continue']]) {
    assert.equal(await visibilityPage.locator('#' + id).isVisible(), true);
    assert.ok(texts.some(n => n.text === text), `visible descendant missing: ${text}`);
    const captured = visibility.nodes.find(n => n.ref === texts.find(n => n.text === text).parentRef);
    const bounds = await visibilityPage.locator('#' + id).evaluate(el => {
      const rect = el.getBoundingClientRect(), root = document.querySelector('#root').getBoundingClientRect();
      return { x: rect.x - root.x, y: rect.y - root.y, width: rect.width, height: rect.height };
    });
    for (const key of ['x', 'y', 'width', 'height']) assert.equal(captured[key], bounds[key]);
  }
  assert.ok(texts.some(n => n.text === 'Direct contents text'));
  assert.equal(visibility.coverage.complete, true);
  assert.ok(!JSON.stringify(visibility).includes('SENTINEL'), 'flattened containers must preserve visibility and sensitive-content exclusions');
  assert.ok(!visibility.nodes.some(n => n.kind === 'IMAGE'), 'hidden images must not turn into visible placeholders');
  const download = texts.find(n => n.text === 'Download');
  assert.equal(visibility.nodes.find(n => n.ref === download.parentRef).opacity, 0.5);
  const continued = texts.find(n => n.text === 'Continue');
  const hiddenCarrier = visibility.nodes.find(n => n.ref === visibility.nodes.find(n => n.ref === continued.parentRef).parentRef);
  assert.equal(hiddenCarrier.fill, null, 'hidden ancestor must not paint its own background');
  const visibilityPackaged = webSnapshotSchema.parse(await visibilityPage.evaluate(`${bundled.trim()}({selector:'#root'})`));
  assert.deepEqual(visibilityPackaged, visibility);
  const visibilityBounded = await captureVisibility({ maxNodes: 3 });
  assert.equal(visibilityBounded.nodes.length, 3); assert.equal(visibilityBounded.coverage.complete, false);
  await visibilityPage.setContent('<main id="root" style="width:600px;height:500px"><div style="height:0;overflow:hidden"><button>Clipped</button></div></main>');
  const clipped = await captureVisibility();
  assert.ok(!clipped.nodes.some(n => n.text === 'Clipped'));
  assert.equal(clipped.coverage.complete, false);
  assert.ok(clipped.warnings.some(w => w.code === 'boxless_clipping_omitted'));
  await visibilityPage.close();
  if (options['--output']) {
    const directory = resolve(options['--output']); await mkdir(directory, { recursive: true });
    await page.locator('#fixture').screenshot({ path: join(directory, 'source.png') });
    await writeFile(join(directory, 'snapshot.json'), JSON.stringify(snapshot, null, 2) + '\n');
  }
  console.log(JSON.stringify({ browser: 'chromium', capture: 'passed', schema: 'passed', DOMUnchanged: true,
    sensitiveFieldsExcluded: true, corsRespected: true, portableScript: 'passed', mockedImport: 'passed', visibleDescendants: 'passed',
    nodes: snapshot.nodes.length, images: snapshot.images.length, warnings: snapshot.warnings.length,
    liveFigmaVerification: 'not_run' }));
} finally {
  await browser?.close();
  await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
}
