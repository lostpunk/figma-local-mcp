import test from 'node:test';
import assert from 'node:assert/strict';
import { pluginHarness } from './plugin-harness.mjs';

test('bounded reads, mixed values and long text are explicit', async () => {
  const h = pluginHarness();
  const frame = h.node('FRAME', 'Main', h.page);
  const text = h.node('TEXT', 'Label', frame);
  text.characters = 'x'.repeat(12000);
  text.fontName = h.figma.mixed;
  h.node('RECTANGLE', 'Other', frame);
  const { result } = await h.call('get_node', { nodeId: frame.id, depth: 6, maxNodes: 2 });
  assert.equal(result.children.length, 1);
  assert.equal(result.childrenTruncated, true);
  assert.equal(result.children[0].characters.length, 10000);
  assert.equal(result.children[0].characterCount, 12000);
  assert.deepEqual(result.children[0].fontName, { mixed: true });
});

test('create/update/delete preserves parent and dimensions; failed creates clean up', async () => {
  const h = pluginHarness();
  const frame = h.node('FRAME', 'Main', h.page);
  const created = await h.call('create_node', { type: 'RECTANGLE', parentId: frame.id,
    props: { name: 'Button', width: 240, height: 48, fill: '#ff0000' } });
  assert.equal(created.error, undefined);
  const node = h.nodes.get(created.result.id);
  assert.equal(node.parent, frame);
  assert.equal(node.fills[0].color.r, 1);
  const update = await h.call('update_node', { nodeId: node.id, props: { width: 320, name: 'Updated' } });
  assert.equal(update.result.width, 320);
  assert.equal(update.result.height, 48);
  const count = h.nodes.size;
  const failed = await h.call('create_node', { type: 'ELLIPSE', props: { characters: 'invalid' } });
  assert.match(failed.error, /not supported/);
  assert.equal(h.nodes.size, count);
  assert.equal((await h.call('delete_node', { nodeId: node.id })).result.deleted.id, node.id);
  assert.equal(node.removed, true);
  assert.equal(h.undoCount, 3);
});

test('all fonts are loaded before modifying mixed text', async () => {
  const h = pluginHarness();
  const node = h.node('TEXT', 'Title', h.page);
  node.fontName = h.figma.mixed;
  node.characters = 'old';
  node.rangeFonts = [{ family: 'Inter', style: 'Regular' }, { family: 'Inter', style: 'Bold' }];
  const result = await h.call('update_node', { nodeId: node.id, props: { characters: 'new' } });
  assert.equal(result.error, undefined);
  assert.deepEqual(h.fonts.map(f => f.style), ['Regular', 'Bold']);
  assert.equal(node.characters, 'new');
});

test('search pagination includes nested text without duplicate matches', async () => {
  const h = pluginHarness();
  const frame = h.node('FRAME', 'Main', h.page);
  const first = h.node('TEXT', 'first', frame);
  first.characters = 'Needle';
  const second = h.node('RECTANGLE', 'Needle 2', h.page);
  const args = { query: 'needle', offset: 0, limit: 1, maxVisited: 20 };
  const a = (await h.call('find_nodes', args)).result;
  const b = (await h.call('find_nodes', { ...args, offset: a.nextOffset })).result;
  const c = (await h.call('find_nodes', { ...args, offset: b.nextOffset })).result;
  assert.deepEqual([...a.nodes, ...b.nodes].map(n => n.id), [first.id, second.id]);
  assert.equal(c.complete, true);
});

test('preflight rejects unsupported fields before changing node, pages cannot be deleted', async () => {
  const h = pluginHarness();
  const node = h.node('ELLIPSE', 'Original', h.page);
  const result = await h.call('update_node', { nodeId: node.id, props: { name: 'Changed', cornerRadius: 2 } });
  assert.match(result.error, /not supported/);
  assert.equal(node.name, 'Original');
  assert.match((await h.call('delete_node', { nodeId: h.page.id })).error, /scene node/);
});

test('export clamps large PNG bounds and returns SVG text', async () => {
  const h = pluginHarness();
  const node = h.node('RECTANGLE', 'Huge', h.page);
  node.absoluteBoundingBox.width = 8192;
  const png = (await h.call('export_node', { nodeId: node.id, format: 'PNG', scale: 2 })).result;
  assert.equal(png.scale, 0.5);
  assert.equal(node.lastExport.constraint.value, 0.5);
  assert.equal((await h.call('export_node', { nodeId: node.id, format: 'SVG' })).result.svg, '<svg/>');
});

test('selection rejects mixed pages before changing active page', async () => {
  const h = pluginHarness();
  const otherPage = h.node('PAGE', 'Second', h.root);
  const a = h.node('RECTANGLE', 'A', h.page);
  const b = h.node('RECTANGLE', 'B', otherPage);
  assert.match((await h.call('set_selection', { nodeIds: [a.id, b.id], focus: true })).error, /same page/);
  assert.equal(h.figma.currentPage, h.page);
  assert.equal((await h.call('set_selection', { nodeIds: [b.id], focus: true })).error, undefined);
  assert.equal(h.figma.currentPage, otherPage);
});

test('page updates, reparenting and image fills preserve the intended document state', async () => {
  const h = pluginHarness();
  const screen = h.node('FRAME', 'Screen', h.page);
  screen.x = 1600;
  screen.y = 40;
  screen.absoluteBoundingBox = { x: 1600, y: 40, width: 100, height: 100 };
  const card = h.node('RECTANGLE', 'Card', h.page);
  card.x = 1664;
  card.y = 120;
  card.absoluteBoundingBox = { x: 1664, y: 120, width: 100, height: 100 };

  const page = await h.call('update_page', { pageId: h.page.id, name: 'Screens', background: '#fffdf9' });
  assert.equal(page.error, undefined);
  assert.equal(h.page.name, 'Screens');
  assert.equal(h.page.backgrounds[0].color.r, 1);

  const moved = await h.call('reparent_nodes', { parentId: screen.id, nodeIds: [card.id] });
  assert.equal(moved.error, undefined);
  assert.equal(card.parent, screen);
  assert.equal(card.x, 64);
  assert.equal(card.y, 80);

  const image = await h.call('set_image_fill', { nodeId: card.id, base64: 'iVBORw0KGgo=', scaleMode: 'FIT' });
  assert.equal(image.error, undefined);
  assert.equal(card.fills[0].type, 'IMAGE');
  assert.equal(card.fills[0].scaleMode, 'FIT');
});

test('layer order is explicit and reparenting can insert a background at the back', async () => {
  const h = pluginHarness();
  const screen = h.node('FRAME', 'Screen', h.page);
  const content = h.node('RECTANGLE', 'Content', screen);
  const overlay = h.node('RECTANGLE', 'Overlay', screen);
  const background = h.node('RECTANGLE', 'Background', h.page);

  const moved = await h.call('reparent_nodes', { parentId: screen.id, nodeIds: [background.id], insertIndex: 0 });
  assert.equal(moved.error, undefined);
  assert.deepEqual(screen.children.map(node => node.name), ['Background', 'Content', 'Overlay']);

  const reordered = await h.call('reorder_nodes', { parentId: screen.id, nodeIds: [overlay.id], index: 0 });
  assert.equal(reordered.error, undefined);
  assert.deepEqual(screen.children.map(node => node.name), ['Overlay', 'Background', 'Content']);
});
