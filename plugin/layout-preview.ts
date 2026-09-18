export function layoutDescendants(node: any) {
  const descendants: any[] = [];
  function visit(current: any) {
    for (const child of current.children ?? []) {
      if (descendants.length >= 100) throw new Error('Layout preview supports at most 100 descendants.');
      descendants.push(child); visit(child);
    }
  }
  visit(node);
  return descendants;
}
export const layoutProperties = new Set(['width', 'height', 'itemSpacing', 'paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight']);
export const isLayoutEdit = (node: any, props: Record<string, any>) => node.type === 'FRAME'
  && Object.keys(props).some(key => layoutProperties.has(key));

// Exact arithmetic only for fixed-size, non-wrapping stacks. No speculative canvas mutations.
export function predictLayout(node: any, props: Record<string, any>) {
  if (!['HORIZONTAL', 'VERTICAL'].includes(node.layoutMode)) throw new Error('Layout preview requires an existing horizontal or vertical Auto Layout frame.');
  if (node.primaryAxisSizingMode !== 'FIXED' || node.counterAxisSizingMode !== 'FIXED'
      || node.layoutWrap === 'WRAP' || node.counterAxisAlignItems === 'BASELINE'
      || (node.strokes?.some((p: any) => p.visible !== false) && node.strokesIncludedInLayout))
    throw new Error('Layout preview requires fixed axes without wrapping, baseline alignment or included strokes.');
  for (let current = node; current && current.type !== 'PAGE'; current = current.parent) {
    if (current !== node && (current.type === 'GROUP' || ['INSTANCE', 'COMPONENT', 'COMPONENT_SET'].includes(current.type)
        || (current.layoutMode && current.layoutMode !== 'NONE')))
      throw new Error('Layout preview requires a regular ancestor hierarchy.');
    if (current.locked || current.visible === false || current.opacity === 0 || current.isMask
        || current.parent?.children?.some((child: any) => child.isMask))
      throw new Error('Hidden, locked or masked layout requires manual review.');
    const m = current.relativeTransform;
    if (!m || m[0][0] !== 1 || m[0][1] !== 0 || m[1][0] !== 0 || m[1][1] !== 1)
      throw new Error('Transformed layout requires manual review.');
  }
  if (['minWidth', 'maxWidth', 'minHeight', 'maxHeight'].some(key => node[key] != null))
    throw new Error('Layout min/max constraints require manual review.');
  const descendants = layoutDescendants(node);
  const children = node.children.filter((c: any) => c.visible !== false);
  for (const child of children) {
    const m = child.relativeTransform;
    if (child.layoutPositioning === 'ABSOLUTE' || child.layoutGrow || child.layoutAlign === 'STRETCH'
        || child.layoutSizingHorizontal === 'FILL' || child.layoutSizingVertical === 'FILL'
        || child.isMask || !m || m[0][0] !== 1 || m[0][1] !== 0 || m[1][0] !== 0 || m[1][1] !== 1)
      throw new Error('Layout children must have fixed measured sizes, without fill, stretch, absolute placement or transforms.');
  }
  const value = (key: string) => props[key] ?? node[key];
  const horizontal = node.layoutMode === 'HORIZONTAL';
  const width = value('width'), height = value('height');
  const main = horizontal ? width : height, cross = horizontal ? height : width;
  const start = value(horizontal ? 'paddingLeft' : 'paddingTop'), end = value(horizontal ? 'paddingRight' : 'paddingBottom');
  const crossStart = value(horizontal ? 'paddingTop' : 'paddingLeft'), crossEnd = value(horizontal ? 'paddingBottom' : 'paddingRight');
  const sizes = children.map((c: any) => horizontal ? c.width : c.height);
  const used = sizes.reduce((sum: number, n: number) => sum + n, 0);
  const align = node.primaryAxisAlignItems ?? 'MIN', crossAlign = node.counterAxisAlignItems ?? 'MIN';
  if (!['MIN', 'CENTER', 'MAX', 'SPACE_BETWEEN'].includes(align) || !['MIN', 'CENTER', 'MAX'].includes(crossAlign))
    throw new Error('Unsupported layout alignment.');
  const remaining = main - start - end - used;
  const gap = align === 'SPACE_BETWEEN' && children.length > 1 ? Math.max(0, remaining / (children.length - 1)) : value('itemSpacing');
  const free = remaining - Math.max(0, children.length - 1) * gap;
  if (free < -0.01) throw new Error('Proposed layout does not fit its main axis.');
  let cursor = start + (align === 'CENTER' ? free / 2 : align === 'MAX' ? free : 0);
  const effects = children.map((child: any, index: number) => {
    const crossSize = horizontal ? child.height : child.width, crossFree = cross - crossStart - crossEnd - crossSize;
    if (crossFree < -0.01) throw new Error('Proposed layout does not fit its cross axis.');
    const other = crossStart + (crossAlign === 'CENTER' ? crossFree / 2 : crossAlign === 'MAX' ? crossFree : 0);
    const after = { x: horizontal ? cursor : other, y: horizontal ? other : cursor, width: child.width, height: child.height };
    cursor += sizes[index] + gap;
    return { nodeId: child.id, before: { x: child.x, y: child.y, width: child.width, height: child.height }, after };
  });
  if (!Object.values({ width, height, start, end, crossStart, crossEnd, gap }).every(Number.isFinite))
    throw new Error('Layout geometry is unavailable.');
  return { nodeId: node.id, frame: { width, height }, children: effects, descendants };
}
