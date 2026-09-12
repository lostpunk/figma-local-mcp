import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { guideSchema } from '../src/design-schema.mjs';
import { pluginHarness } from './plugin-harness.mjs';

const guideArgs = (extra = {}) => z.object(guideSchema).parse({ name: 'Limited file', ...extra });
const caps = async h => (await h.call('get_document')).result.capabilities;
const choose = (h, plan) => h.figma.ui.onmessage({ type: 'set-plan', plan });
function fillPages(h) { h.node('PAGE', 'Components', h.root); h.node('PAGE', 'Screens', h.root); }

test('unknown plan stays unknown and blocks a fourth page before invoking Figma', async () => {
  const h = pluginHarness();
  fillPages(h);
  let attempts = 0;
  h.figma.createPage = () => { attempts++; throw new Error('must not be called'); };
  const c = await caps(h);
  assert.equal(c.plan, 'unknown');
  assert.equal(c.planSource, 'not_exposed_by_plugin_api');
  assert.equal(c.limitSource, 'conservative_default');
  assert.equal(c.pageCount, 3);
  assert.equal(c.canCreatePage, false);
  assert.match((await h.call('create_page', { name: 'Fourth' })).error, /PAGE_LIMIT/);
  assert.equal(attempts, 0);
  assert.equal(h.root.children.length, 3);
});

test('page creation reuses a matching page and respects a per-file declared plan', async () => {
  const h = pluginHarness();
  fillPages(h);
  const reuse = (await h.call('create_page', { name: 'Components' })).result;
  assert.equal(reuse.reused, true);
  assert.equal(h.root.children.length, 3);
  await choose(h, 'starter');
  assert.match((await h.call('create_page', { name: 'Fourth' })).error, /PAGE_LIMIT/);
  await choose(h, 'professional');
  const c = await caps(h);
  assert.equal(c.planSource, 'user_declared');
  assert.equal(c.planAutomaticallyDetected, false);
  assert.equal(c.effectivePageLimit, null);
  assert.equal((await h.call('create_page', { name: 'Fourth' })).error, undefined);
  assert.equal(h.root.children.length, 4);
  assert.equal((await caps(pluginHarness())).plan, 'unknown');
});

test('a real Figma limit error overrides a wrong declaration and prevents subsequent attempts', async () => {
  const h = pluginHarness();
  fillPages(h);
  await choose(h, 'professional');
  let attempts = 0;
  h.figma.createPage = () => { attempts++; throw new Error('The Starter plan only comes with 3 pages. Upgrade to Professional'); };
  assert.match((await h.call('create_page', { name: 'Fourth' })).error, /PAGE_LIMIT/);
  assert.equal((await caps(h)).planSource, 'figma_error');
  assert.equal((await caps(h)).plan, 'starter');
  await h.call('create_page', { name: 'Fourth again' });
  assert.equal(attempts, 1);
});

test('style guide at the limit uses an existing page and does not overlap existing content', async () => {
  const h = pluginHarness();
  fillPages(h);
  const existing = h.node('FRAME', 'Keep', h.page);
  existing.x = 200; existing.width = 1440;
  h.figma.createPage = () => { throw new Error('must not be called'); };
  const response = await h.call('create_style_guide', guideArgs());
  assert.equal(response.error, undefined);
  assert.equal(response.result.createdPage, false);
  assert.equal(response.result.pageId, h.page.id);
  assert.ok(h.nodes.get(response.result.frameId).x > 1640);
  assert.equal(h.root.children.length, 3);
  assert.equal(h.collections.size, 1);
  assert.equal(existing.removed, false);
});

test('failed guide on an existing page removes only its own board and resources', async () => {
  const h = pluginHarness();
  const existing = h.node('FRAME', 'Keep', h.page);
  h.figma.createRectangle = () => { throw new Error('specimen failure'); };
  const response = await h.call('create_style_guide', guideArgs({ pageId: h.page.id }));
  assert.match(response.error, /resources cleaned up/);
  assert.equal(h.page.removed, false);
  assert.deepEqual(h.page.children.map(n => n.id), [existing.id]);
  assert.equal(h.variables.size, 0);
  assert.equal(h.styles.size, 0);
  assert.equal(h.collections.size, 0);
});

test('scene roots stay on the original page when the user switches pages during font loading', async () => {
  const h = pluginHarness();
  const other = h.node('PAGE', 'Other', h.root);
  h.figma.loadFontAsync = async () => { h.figma.currentPage = other; };
  const r = await h.call('create_scene', { nodes: [
    { ref: 'first', type: 'TEXT', props: { characters: 'First' } },
    { ref: 'second', type: 'RECTANGLE', props: {} },
  ] });
  assert.equal(r.error, undefined);
  assert.ok(r.result.nodes.every(n => h.nodes.get(n.id).parent === h.page));
  assert.equal(other.children.length, 0);
});
