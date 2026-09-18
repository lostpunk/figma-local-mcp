import { DesignRules, resolveDesignRules, inspectDesignNode } from './design-review';
type StateRule = { nodeId: string; property: string; required: string[] };
type AuditArgs = {
  maxNodes?: number; maxFindings?: number; tolerance?: number;
  checkTextStyles?: boolean; maxStyles?: number;
  rules?: { designSystem?: DesignRules; spacing?: number[]; componentStates?: StateRule[] };
};
type Finding = {
  code: string; severity: 'warning' | 'info'; nodeId?: string; name?: string;
  message: string; evidence?: Record<string, unknown>;
};
const bounded = (value: string) => value.slice(0, 200);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

// Work in the parent's coordinate system, so rotated frames do not cause false positives.
function localBounds(node: SceneNode) {
  const m = node.relativeTransform;
  const corners = [[0, 0], [node.width, 0], [0, node.height], [node.width, node.height]];
  const xs = corners.map(([x, y]) => m[0][0] * x + m[0][1] * y + m[0][2]);
  const ys = corners.map(([x, y]) => m[1][0] * x + m[1][1] * y + m[1][2]);
  return { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) };
}

export async function auditDesign(root: BaseNode, args: AuditArgs) {
  if (root.type === 'DOCUMENT') throw new Error('Audit one page or scene node, not the entire document');
  const maxNodes = args.maxNodes ?? 2000, maxFindings = args.maxFindings ?? 100;
  const tolerance = args.tolerance ?? 0.5, maxStyles = args.maxStyles ?? 500;
  const rules = args.rules ?? {};
  const findings: Finding[] = [];
  let findingCount = 0, visited = 0, checked = 0, hiddenSubtrees = 0, failedChecks = 0;
  let stylesChecked = 0, stylesTruncated = false;
  const seenStateRules = new Set<StateRule>();
  const add = (finding: Finding) => {
    findingCount++;
    if (findings.length < maxFindings) findings.push(finding);
  };
  const note = (node: BaseNode, code: string, message: string, evidence?: Record<string, unknown>, severity: 'warning' | 'info' = 'warning') =>
    add({ code, severity, nodeId: node.id, name: bounded(node.name), message, evidence });

  let designResources: Awaited<ReturnType<typeof resolveDesignRules>> | undefined;
  let designChecked = 0, designIgnored = 0;
  if (rules.designSystem) {
    try { designResources = await resolveDesignRules(rules.designSystem); }
    catch (error) { failedChecks++; add({ code: 'DESIGN_RULES_INVALID', severity: 'warning', message: error instanceof Error ? error.message : String(error) }); }
  }

  const check = async (node: SceneNode | PageNode) => {
    if (designResources && rules.designSystem && node.type !== 'PAGE') {
      if (rules.designSystem.ignoreNodeIds?.includes(node.id)) designIgnored++;
      else {
        for (const finding of await inspectDesignNode(node, rules.designSystem, designResources))
          note(node, finding.code, finding.message, finding.evidence);
        designChecked++;
      }
    }
    const parent = node.parent;
    if (node !== root && node.type !== 'PAGE' && parent &&
        ['FRAME', 'COMPONENT', 'INSTANCE', 'SECTION'].includes(parent.type) && 'width' in parent) {
      const box = localBounds(node);
      const scrolling = 'overflowDirection' in parent ? parent.overflowDirection : 'NONE';
      const scrollX = scrolling === 'HORIZONTAL' || scrolling === 'BOTH';
      const scrollY = scrolling === 'VERTICAL' || scrolling === 'BOTH';
      const outsideX = !scrollX && (box.left < -tolerance || box.right > parent.width + tolerance);
      const outsideY = !scrollY && (box.top < -tolerance || box.bottom > parent.height + tolerance);
      if (outsideX || outsideY) note(node, 'OUTSIDE_PARENT', 'Layer geometry extends beyond its parent. Review clipping, masks and intentional decoration.',
        { parentId: parent.id, bounds: box, parentSize: { width: parent.width, height: parent.height },
          clipsContent: 'clipsContent' in parent ? parent.clipsContent : false });
    }
    if ('layoutMode' in node && ['HORIZONTAL', 'VERTICAL'].includes(node.layoutMode) && rules.spacing?.length) {
      const properties: string[] = ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'];
      if (node.primaryAxisAlignItems !== 'SPACE_BETWEEN') properties.push('itemSpacing');
      if (node.layoutWrap === 'WRAP' && node.counterAxisAlignContent !== 'SPACE_BETWEEN') properties.push('counterAxisSpacing');
      const values = node as unknown as Record<string, unknown>;
      const offScale = properties.filter(key => finite(values[key]) &&
        ![0, ...rules.spacing!].some(value => Math.abs((values[key] as number) - value) <= tolerance));
      if (offScale.length) note(node, 'SPACING_OFF_SCALE', 'Auto-layout spacing differs from the supplied project scale.',
        { properties: Object.fromEntries(offScale.map(key => [key, values[key]])), allowed: [0, ...rules.spacing] });
    }
    if (node.type === 'TEXT') {
      if (node.hasMissingFont) note(node, 'MISSING_FONT', 'Text uses a font unavailable in this document.');
      if (node.textTruncation === 'ENDING' || node.textAutoResize === 'TRUNCATE') {
        note(node, 'TEXT_TRUNCATION_ENABLED', 'Ellipsis is enabled; verify that shortened text is intentional. This does not prove overflow.',
          { maxLines: node.maxLines ?? null }, 'info');
      } else if (node.textAutoResize === 'NONE') {
        // Render bounds include shadows and strokes. Exclude those cases instead of treating them as overflow.
        const rendered = node.absoluteRenderBounds, box = node.absoluteBoundingBox;
        if (!node.effects.some(effect => effect.visible !== false) && !node.strokes.some(paint => paint.visible !== false) && rendered && box &&
            (rendered.x < box.x - tolerance || rendered.y < box.y - tolerance ||
             rendered.x + rendered.width > box.x + box.width + tolerance || rendered.y + rendered.height > box.y + box.height + tolerance)) {
          note(node, 'TEXT_RENDER_OUTSIDE_BOX', 'Rendered text extends beyond its fixed box. Check overflow or intentional glyph overhang in the preview.',
            { bounds: box, rendered }, 'warning');
        }
      }
    }
    for (const rule of rules.componentStates ?? []) {
      if (rule.nodeId !== node.id) continue;
      seenStateRules.add(rule);
      if (node.type !== 'COMPONENT_SET') {
        failedChecks++;
        note(node, 'STATE_RULE_TARGET_INVALID', 'State rules must target a verified component set.');
        continue;
      }
      const property = node.componentPropertyDefinitions[rule.property];
      const actual = property?.type === 'VARIANT' ? property.variantOptions ?? [] : [];
      const missing = rule.required.filter(value => !actual.includes(value));
      if (missing.length) note(node, 'COMPONENT_STATES_MISSING', 'Required values are absent from the specified variant property.',
        { property: rule.property, missing, available: actual.slice(0, 50), availableTruncated: actual.length > 50 });
    }
  };

  let hiddenAncestor = false;
  for (let parent = root.parent; parent; parent = parent.parent) {
    if (('visible' in parent && !parent.visible) || ('opacity' in parent && parent.opacity === 0)) hiddenAncestor = true;
  }
  const stack: Iterator<BaseNode>[] = [[root][Symbol.iterator]()];
  let nodesTruncated = false;
  while (stack.length) {
    const next = stack[stack.length - 1].next();
    if (next.done) { stack.pop(); continue; }
    if (visited >= maxNodes) { nodesTruncated = true; break; }
    const node = next.value;
    visited++;
    if (hiddenAncestor || ('visible' in node && !node.visible) || ('opacity' in node && node.opacity === 0)) {
      hiddenSubtrees++;
      continue;
    }
    try {
      await check(node as SceneNode | PageNode);
      checked++;
    } catch {
      failedChecks++;
      note(node, 'NODE_CHECK_FAILED', 'Could not inspect all properties of this node; this part of the audit is incomplete.');
    }
    if ('children' in node) stack.push((node as ChildrenMixin).children[Symbol.iterator]());
  }

  if (args.checkTextStyles !== false) {
    try {
      const styles = await figma.getLocalTextStylesAsync();
      stylesTruncated = styles.length > maxStyles;
      const names = new Map<string, { count: number; ids: string[] }>();
      for (const style of styles.slice(0, maxStyles)) {
        stylesChecked++;
        const group = names.get(style.name) ?? { count: 0, ids: [] };
        group.count++;
        if (group.ids.length < 20) group.ids.push(style.id);
        names.set(style.name, group);
      }
      for (const [name, group] of names) if (group.count > 1) add({
        code: 'DUPLICATE_TEXT_STYLE_NAME', severity: 'info', name: bounded(name),
        message: 'Multiple local text styles share this exact name; compare their definitions before merging.',
        evidence: { styleIds: group.ids, count: group.count, idsTruncated: group.count > group.ids.length },
      });
    } catch {
      failedChecks++;
      add({ code: 'STYLE_CHECK_FAILED', severity: 'warning', message: 'Local text styles could not be inspected.' });
    }
  }
  const uncheckedStateRules = (rules.componentStates ?? []).filter(rule => !seenStateRules.has(rule))
    .map(rule => ({ nodeId: rule.nodeId, property: rule.property, reason: 'Target outside the visited visible subtree, missing, or traversal truncated.' }));
  return {
    rootId: root.id, readOnly: true, findings, findingCount,
    complete: !nodesTruncated && findingCount <= maxFindings && !stylesTruncated && !failedChecks && !uncheckedStateRules.length,
    coverage: { visited, checked, hiddenSubtrees, nodesTruncated, findingsTruncated: findingCount > maxFindings,
      textStyles: { scope: 'local_file', enabled: args.checkTextStyles !== false, checked: stylesChecked, truncated: stylesTruncated },
      designSystem: { enabled: Boolean(rules.designSystem), checked: designChecked, ignored: designIgnored },
      spacingChecked: Boolean(rules.spacing?.length), stateRulesChecked: seenStateRules.size, uncheckedStateRules, failedChecks },
    limitations: [
      'Findings are review candidates, not automatic fixes or an accessibility certification.',
      'Text checks detect render-bound overflow and configured ellipsis, not all truncation or wrapping problems. Inspect an export.',
      'Geometry excludes shadows/strokes and allows declared scrolling axes. Masks, overlaps and intentional decoration need visual review.',
      'Spacing checks cover explicit linear auto-layout gaps/padding, not arbitrary positions or grid layout. Zero is always allowed.',
      'Duplicate checks compare local text-style names only. Variant checks cover supplied property values, not every combination or prototype behavior.',
    ],
  };
}
