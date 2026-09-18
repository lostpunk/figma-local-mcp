// A read-only proposal based on existing ink bounds, never temporary text nodes.
export function textHeightProposal(node: any, requested?: number, tolerance = 0.5) {
  if (node.type !== 'TEXT' || node.textAutoResize !== 'NONE' || node.textTruncation === 'ENDING')
    throw new Error('Text fix requires fixed-size text without ellipsis.');
  if (node.hasMissingFont || typeof node.fontName !== 'object' || typeof node.fontSize !== 'number'
      || (node.textAlignVertical && node.textAlignVertical !== 'TOP'))
    throw new Error('Missing/mixed fonts or vertical text alignment require manual review.');
  if (node.effects.some((v: any) => v.visible !== false) || node.strokes.some((v: any) => v.visible !== false))
    throw new Error('Text effects or strokes make render bounds ambiguous.');
  const parent = node.parent;
  if (parent?.type !== 'FRAME' || parent.layoutMode !== 'NONE' || (parent.overflowDirection && parent.overflowDirection !== 'NONE'))
    throw new Error('Text fix requires a regular non-scrolling frame.');
  for (let current = node; current && current.type !== 'PAGE'; current = current.parent) {
    if (current.visible === false || current.opacity === 0 || current.locked || current.isMask
        || ['INSTANCE', 'COMPONENT', 'COMPONENT_SET', 'GROUP'].includes(current.type)
        || (current.layoutMode && current.layoutMode !== 'NONE')
        || current.parent?.children?.some((child: any) => child.isMask))
      throw new Error('Hidden, locked, masked, component or Auto Layout hierarchies require manual review.');
    const m = current.relativeTransform;
    if (!m || m[0][0] !== 1 || m[0][1] !== 0 || m[1][0] !== 0 || m[1][1] !== 1)
      throw new Error('Transformed text or ancestors require manual review.');
  }
  if (parent.children.length > 200) throw new Error('Too many siblings for a bounded text fix.');
  const box = node.absoluteBoundingBox, ink = node.absoluteRenderBounds;
  if (!box || !ink || ![box.x, box.y, box.width, box.height, ink.x, ink.y, ink.width, ink.height].every(Number.isFinite))
    throw new Error('Text render bounds are unavailable.');
  if (ink.x < box.x - tolerance || ink.x + ink.width > box.x + box.width + tolerance || ink.y < box.y - tolerance)
    throw new Error('Horizontal or top glyph overflow requires manual review.');
  const minimum = Math.ceil(ink.y + ink.height - box.y);
  const height = requested ?? minimum;
  if (!Number.isFinite(height) || height <= node.height || height < minimum || height > 100000)
    throw new Error('Text height must grow to contain the current rendered text.');
  if (node.x < 0 || node.y < 0 || node.x + node.width > parent.width || node.y + height > parent.height)
    throw new Error('Text cannot grow within its parent.');
  // Check only the newly occupied strip. Existing overlap may be an intentional background.
  const strip = { x: box.x, right: box.x + box.width, y: box.y + node.height, bottom: box.y + height };
  for (const sibling of parent.children) {
    if (sibling === node || sibling.visible === false || sibling.opacity === 0) continue;
    const b = sibling.absoluteBoundingBox;
    if (!b) throw new Error('A sibling has no bounds; inspect text growth manually.');
    const r = sibling.absoluteRenderBounds ?? b;
    const left = Math.min(b.x, r.x), right = Math.max(b.x + b.width, r.x + r.width);
    const top = Math.min(b.y, r.y), bottom = Math.max(b.y + b.height, r.y + r.height);
    if (left < strip.right && right > strip.x && top < strip.bottom && bottom > strip.y)
      throw new Error(`Text growth intersects sibling ${sibling.id}; review spacing manually.`);
  }
  return { height };
}
export function textSiblingState(node: any) {
  return node.parent.children.map((s: any) => ({ id: s.id, visible: s.visible, opacity: s.opacity,
    isMask: s.isMask, bounds: s.absoluteBoundingBox, rendered: s.absoluteRenderBounds }));
}
