import { createChangePreview } from './changes';
import { DesignRules, resolveDesignRules, variableColor, paintMatches, styleMatches, typographyKeys, DesignEdit, validateDesignTarget } from './design-review';

export async function previewDesignFixes(args: { nodeId: string; nodeIds: string[]; rules: DesignRules }, getNode: (id: string) => Promise<BaseNode>) {
  if (!Array.isArray(args.nodeIds) || !args.nodeIds.length || args.nodeIds.length > 50 || new Set(args.nodeIds).size !== args.nodeIds.length)
    throw new Error('Select 1–50 unique layers.');
  const root = await getNode(args.nodeId), resources = await resolveDesignRules(args.rules);
  const resolved: any[] = [], skipped: { nodeId: string; reason: string }[] = [];
  for (const id of args.nodeIds) {
    try { resolved.push(await getNode(id)); } catch { skipped.push({ nodeId: id, reason: 'Layer is unavailable.' }); }
  }
  const entries: { node: any; props: Record<string, string>; design: DesignEdit[] }[] = [];
  for (const node of resolved) {
    try {
      let inScope = node === root;
      for (let parent = node.parent; parent; parent = parent.parent) if (parent === root) inScope = true;
      if (!inScope || args.rules.ignoreNodeIds?.includes(node.id)) throw new Error('Layer is outside scope or explicitly exempt.');
      const props: Record<string, string> = {}, design: DesignEdit[] = [];
      for (const [field, property] of [['fills', 'fillVariableId'], ['strokes', 'strokeVariableId']] as const) {
        const paints = node[field];
        if (!args.rules.colorVariableIds || !Array.isArray(paints) || paints.length !== 1 || paints[0].type !== 'SOLID'
          || paints[0].visible === false || args.rules.colorVariableIds.includes(paints[0].boundVariables?.color?.id)
          || node[field === 'fills' ? 'fillStyleId' : 'strokeStyleId']) continue;
        const candidates = resources.variables.filter(v => paintMatches(paints[0], variableColor(v, node)));
        if (candidates.length !== 1) continue; // Color alone does not identify a semantic role when several tokens match.
        const v = candidates[0]; props[property] = v.id;
        design.push({ property, resourceId: v.id, signature: JSON.stringify(variableColor(v, node)) });
      }
      if (node.type === 'TEXT' && args.rules.textStyleIds && !args.rules.textStyleIds.includes(node.textStyleId)) {
        const candidates = resources.styles.filter(s => styleMatches(node, s));
        if (candidates.length === 1 && !node.hasMissingFont && !Object.keys(node.boundVariables ?? {}).length) {
          const style = candidates[0]; props.textStyleId = style.id;
          design.push({ property: 'textStyleId', resourceId: style.id, signature: JSON.stringify(typographyKeys.map(k => (style as any)[k])) });
        }
      }
      if (!design.length) throw new Error('No unique exact match. Select the semantic token/style explicitly; component swaps and mixed paints require manual review.');
      // Validate individually so one unsupported hierarchy does not discard other candidates.
      entries.push({ node, props, design });
    } catch (error) { skipped.push({ nodeId: node.id, reason: error instanceof Error ? error.message : String(error) }); }
  }
  const accepted: typeof entries = [];
  for (const entry of entries) {
    try { validateDesignTarget(entry.node, entry.design); accepted.push(entry); }
    catch (error) { skipped.push({ nodeId: entry.node.id, reason: error instanceof Error ? error.message : String(error) }); }
  }
  const plan = accepted.length ? createChangePreview(accepted) : null;
  return { rootId: root.id, readOnly: true, plan, skipped,
    nextStep: 'Choose semantic bindings, apply selected changes, rerun the audit with the same rules and inspect an export.' };
}
