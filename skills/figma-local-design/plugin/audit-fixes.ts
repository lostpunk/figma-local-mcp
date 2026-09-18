import { textHeightProposal } from './text-fit';
import { createChangePreview, validatePreviewProperties } from './changes';

// Only translation is proposed. Decorations can intentionally overflow, so these are opt-in proposals.
export async function previewAuditFixes(args: { nodeId: string; nodeIds: string[]; tolerance?: number }, getNode: (id: string) => Promise<BaseNode>) {
  if (!Array.isArray(args.nodeIds) || !args.nodeIds.length || args.nodeIds.length > 50
    || new Set(args.nodeIds).size !== args.nodeIds.length) throw new Error('Select 1–50 unique finding node IDs.');
  const tolerance = args.tolerance ?? 0.5;
  if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > 10) throw new Error('Invalid audit tolerance.');
  const root = await getNode(args.nodeId);
  const candidates: { node: any; props: Record<string, number> }[] = [];
  const skipped: { nodeId: string; reason: string }[] = [];
  const resolved: any[] = [];
  for (const id of args.nodeIds) {
    try { resolved.push(await getNode(id)); }
    catch { skipped.push({ nodeId: id, reason: 'Layer is unavailable; rerun the audit.' }); }
  }
  if (root.removed) throw new Error('Audit root was removed.');
  for (const node of resolved) {
    try {
      if (node.removed || node === root) throw new Error('Select a descendant from the audited subtree.');
      let inScope = false;
      for (let current = node.parent; current; current = current.parent) if (current === root) inScope = true;
      if (!inScope) throw new Error('Layer is outside the audited subtree.');
      for (let current = node; current; current = current.parent) {
        if (current.visible === false || current.opacity === 0 || current.locked || current.isMask)
          throw new Error('Hidden, locked or masked hierarchies require manual review.');
        if (current.parent?.children?.some((child: any) => child.isMask))
          throw new Error('A mask in the ancestor hierarchy makes the visible result ambiguous.');
      }
      if (node.type === 'TEXT') {
        const props = textHeightProposal(node, undefined, tolerance);
        validatePreviewProperties(node, props);
        candidates.push({ node, props });
        continue;
      }
      if (!['RECTANGLE', 'ELLIPSE'].includes(node.type)) throw new Error('Only simple rectangles and ellipses have a bounds fix.');
      const parent = node.parent;
      if (parent?.type !== 'FRAME' || parent.layoutMode !== 'NONE') throw new Error('Fix requires a regular frame without Auto Layout.');
      if (parent.overflowDirection && parent.overflowDirection !== 'NONE') throw new Error('Scrolling frames require manual review.');
      const matrix = node.relativeTransform;
      if (matrix[0][0] !== 1 || matrix[0][1] !== 0 || matrix[1][0] !== 0 || matrix[1][1] !== 1)
        throw new Error('Rotated, flipped or transformed layers require manual review.');
      const { x, y, width, height } = node;
      if (![x, y, width, height, parent.width, parent.height].every(Number.isFinite)
        || width <= 0 || height <= 0 || width > parent.width || height > parent.height)
        throw new Error('Layer cannot fit without resizing; no automatic fix proposed.');
      const props: Record<string, number> = {};
      if (x < -tolerance || x + width > parent.width + tolerance) props.x = Math.min(Math.max(x, 0), parent.width - width);
      if (y < -tolerance || y + height > parent.height + tolerance) props.y = Math.min(Math.max(y, 0), parent.height - height);
      if (!Object.keys(props).length) throw new Error('No current OUTSIDE_PARENT finding on this layer.');
      validatePreviewProperties(node, props);
      candidates.push({ node, props });
    } catch (error) { skipped.push({ nodeId: node.id, reason: error instanceof Error ? error.message : String(error) }); }
  }
  // No awaits from current-state validation through plan capture.
  const plan = candidates.length ? createChangePreview(candidates) : null;
  return { readOnly: true, rootId: root.id, rules: ['OUTSIDE_PARENT', 'TEXT_RENDER_OUTSIDE_BOX'], plan, skipped,
    recommendations: candidates.map(({ node }) => ({ nodeId: node.id, reason: node.type === 'TEXT' ? 'Grow the fixed text box to contain its existing ink without changing width or typography. Inspect the export.' : 'Move the entire shape inside its parent without resizing. Check that the overflow is not intentional decoration.' })),
    nextStep: 'Review differences and select change IDs for apply_changes. Then rerun audit_design on the same root and visually inspect it.' };
}
