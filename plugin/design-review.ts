export type DesignRules = { colorVariableIds?: string[]; textStyleIds?: string[]; componentIds?: string[]; ignoreNodeIds?: string[] };
export async function resolveDesignRules(rules: DesignRules) {
  const variables: Variable[] = [], styles: TextStyle[] = [], components: BaseNode[] = [];
  for (const id of rules.colorVariableIds ?? []) {
    const v = await figma.variables.getVariableByIdAsync(id);
    if (!v || v.resolvedType !== 'COLOR') throw new Error(`Expected a COLOR variable: ${id}`);
    variables.push(v);
  }
  for (const id of rules.textStyleIds ?? []) {
    const style = await figma.getStyleByIdAsync(id);
    if (!style || style.type !== 'TEXT') throw new Error(`Expected a text style: ${id}`);
    styles.push(style);
  }
  for (const id of rules.componentIds ?? []) {
    const node = await figma.getNodeByIdAsync(id);
    if (!node || !['COMPONENT', 'COMPONENT_SET'].includes(node.type)) throw new Error(`Expected a component or set: ${id}`);
    components.push(node);
  }
  return { variables, styles, components };
}
export function variableColor(variable: Variable, node: SceneNode) {
  const resolved = variable.resolveForConsumer(node);
  if (resolved.resolvedType !== 'COLOR' || !resolved.value || typeof resolved.value !== 'object' || !('r' in resolved.value))
    throw new Error('Color variable could not be resolved for this layer.');
  return resolved.value as RGBA;
}
export function paintMatches(paint: any, color: RGBA) {
  return paint?.type === 'SOLID' && Math.abs((paint.opacity ?? 1) - color.a) < 0.000001
    && ['r', 'g', 'b'].every(k => Math.abs(paint.color[k] - (color as any)[k]) < 0.000001);
}
export const typographyKeys = ['fontName', 'fontSize', 'lineHeight', 'letterSpacing', 'paragraphSpacing', 'paragraphIndent',
  'textCase', 'textDecoration', 'listSpacing', 'hangingPunctuation', 'hangingList', 'leadingTrim', 'textWrapStyle'];
export function styleMatches(node: any, style: any) {
  return typographyKeys.every(key => JSON.stringify(node[key]) === JSON.stringify(style[key]));
}
export async function inspectDesignNode(node: any, rules: DesignRules, resources: Awaited<ReturnType<typeof resolveDesignRules>>) {
  if (rules.ignoreNodeIds?.includes(node.id)) return [];
  const findings: { code: string; message: string; evidence: Record<string, unknown> }[] = [];
  if (rules.colorVariableIds) for (const field of ['fills', 'strokes']) {
    const paints = node[field];
    if (paints === figma.mixed) {
      findings.push({ code: 'MIXED_COLOR_BINDINGS', message: 'Mixed text paints require range-level review.', evidence: { field } });
      continue;
    }
    if (!Array.isArray(paints)) continue;
    for (const [index, paint] of paints.entries()) {
      if (paint.visible === false || paint.type !== 'SOLID') continue;
      const id = paint.boundVariables?.color?.id;
      if (id && rules.colorVariableIds.includes(id)) continue;
      findings.push({ code: id ? 'COLOR_VARIABLE_OUTSIDE_SYSTEM' : 'UNBOUND_COLOR',
        message: id ? 'Color is bound to a variable outside the supplied project system.' : 'Solid color has no project variable binding.',
        evidence: { field, paintIndex: index, variableId: id ?? null,
          candidateVariableIds: resources.variables.filter(v => paintMatches(paint, variableColor(v, node))).map(v => v.id) } });
    }
  }
  if (node.type === 'TEXT' && rules.textStyleIds && !rules.textStyleIds.includes(node.textStyleId)) findings.push({
    code: 'TEXT_STYLE_OUTSIDE_SYSTEM', message: 'Text has no approved project style. Candidates match current uniform typography exactly.',
    evidence: { textStyleId: typeof node.textStyleId === 'string' ? node.textStyleId : null,
      candidateStyleIds: resources.styles.filter(s => styleMatches(node, s)).map(s => s.id) },
  });
  if (node.type === 'INSTANCE' && rules.componentIds) {
    const main = await node.getMainComponentAsync();
    if (!main || !rules.componentIds.includes(main.id) && !rules.componentIds.includes(main.parent?.id)) findings.push({
      code: 'COMPONENT_OUTSIDE_SYSTEM', message: 'Instance source is outside the supplied project component list; inspect its role before replacement.',
      evidence: { componentId: main?.id ?? null, componentSetId: main?.parent?.type === 'COMPONENT_SET' ? main.parent.id : null },
    });
  }
  return findings;
}

export type DesignEdit = { property: 'fillVariableId' | 'strokeVariableId' | 'textStyleId'; resourceId: string; signature: string };
export async function resolveDesignEdit(node: any, edit: DesignEdit) {
  if (edit.property === 'textStyleId') {
    const style = await figma.getStyleByIdAsync(edit.resourceId);
    if (!style || style.type !== 'TEXT' || !styleMatches(node, style)) throw new Error('Text style or typography changed. Preview again.');
    validateStyleEdit(node, edit, style);
    return style;
  }
  const variable = await figma.variables.getVariableByIdAsync(edit.resourceId);
  if (!variable || variable.resolvedType !== 'COLOR') throw new Error('Color variable is unavailable. Preview again.');
  validateColorEdit(node, edit, variable);
  return variable;
}
export function validateStyleEdit(node: any, edit: DesignEdit, style: any) {
  if (JSON.stringify(typographyKeys.map(key => style[key])) !== edit.signature || !styleMatches(node, style))
    throw new Error('Text style or typography changed. Preview again.');
}
export function validateColorEdit(node: any, edit: DesignEdit, variable: Variable) {
  const color = variableColor(variable, node), paints = node[edit.property === 'fillVariableId' ? 'fills' : 'strokes'];
  if (JSON.stringify(color) !== edit.signature || !Array.isArray(paints) || paints.length !== 1 || !paintMatches(paints[0], color))
    throw new Error('Color or variable mode changed. Preview again.');
}

export function validateDesignTarget(node: any, edits: DesignEdit[]) {
  if (!['RECTANGLE', 'ELLIPSE', 'FRAME', 'TEXT'].includes(node.type)) throw new Error('Binding preview does not support this node type.');
  for (let current = node; current && current.type !== 'DOCUMENT'; current = current.parent)
    if (current.locked || current.isMask || current.visible === false || current.opacity === 0
      || ['COMPONENT', 'COMPONENT_SET', 'INSTANCE'].includes(current.type)) throw new Error('Hidden, locked, masked or component hierarchies require manual binding review.');
  if (edits.some(e => e.property === 'textStyleId') && (typeof node.textStyleId !== 'string' || typeof node.fontName !== 'object'))
    throw new Error('Mixed typography requires manual review.');
}
