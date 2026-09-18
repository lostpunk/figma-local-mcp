type Args = Record<string, any>;
const rgb = (hex: string): RGB => ({ r: parseInt(hex.slice(1, 3), 16) / 255,
  g: parseInt(hex.slice(3, 5), 16) / 255, b: parseInt(hex.slice(5, 7), 16) / 255 });
const same = (a: any, b: any): boolean => {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 0.000001;
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => same(a[key], b[key]));
};

export async function syncGuide(args: Args) {
  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  const collection = collections.find(c => c.id === args.collectionId);
  if (!collection || collection.remote) throw new Error('Local collection not found; inspect get_design_system first.');
  const variables = (await figma.variables.getLocalVariablesAsync()).filter(v => v.variableCollectionId === collection.id);
  const styles = await figma.getLocalTextStylesAsync();
  if (args.typography?.length && collections.filter(c => c.name === collection.name).length > 1) {
    throw new Error('Several collections share this name; text style namespace is ambiguous. Resolve names before syncing typography.');
  }
  const modeId = collection.defaultModeId;
  const variablePlan: { name: string; type: VariableResolvedDataType; value: VariableValue; existing?: Variable; changed: boolean }[] = [];
  const stylePlan: { name: string; spec: Args; existing?: TextStyle; changed: boolean }[] = [];
  for (const [group, prefix, type] of [['colors', 'color', 'COLOR'], ['spacing', 'spacing', 'FLOAT'], ['radii', 'radius', 'FLOAT']]) {
    for (const token of args[group] ?? []) {
      const name = `${prefix}/${token.name}`;
      const matches = variables.filter(v => v.name === name);
      if (matches.length > 1) throw new Error(`Ambiguous variable name: ${name}. Resolve duplicate names before syncing.`);
      const existing = matches[0];
      if (existing && (existing.remote || existing.resolvedType !== type)) throw new Error(`Variable type/locality conflict: ${name}`);
      if (existing && existing.valuesByMode[modeId] === undefined) throw new Error(`Default mode has no value for ${name}`);
      const value = type === 'COLOR' ? rgb(token.value) : token.value;
      const previous = existing?.valuesByMode[modeId];
      const equal = type === 'COLOR' && previous && typeof previous === 'object' && 'r' in previous
        ? same({ ...previous, a: 'a' in previous ? previous.a : 1 }, { ...value, a: 1 })
        : same(previous, value);
      variablePlan.push({ name, type: type as VariableResolvedDataType, value, existing,
        changed: !existing || !equal });
    }
  }
  for (const spec of args.typography ?? []) {
    const name = `${collection.name}/${spec.name}`;
    const matches = styles.filter(s => s.name === name);
    if (matches.length > 1) throw new Error(`Ambiguous text style name: ${name}. Resolve duplicate names before syncing.`);
    const existing = matches[0];
    if (existing?.remote) throw new Error(`Text style is remote: ${name}`);
    // Omitted lineHeight preserves an existing style's setting.
    const lineHeight = spec.lineHeight === undefined ? existing?.lineHeight ?? { unit: 'AUTO' } : { unit: 'PIXELS', value: spec.lineHeight };
    const desired = { fontName: { family: spec.fontFamily, style: spec.fontStyle }, fontSize: spec.fontSize, lineHeight };
    const changed = !existing || existing.fontName.family !== desired.fontName.family || existing.fontName.style !== desired.fontName.style ||
      !same(existing.fontSize, desired.fontSize) || !same(existing.lineHeight, desired.lineHeight);
    if (changed && existing && Object.keys(existing.boundVariables ?? {}).length) {
      throw new Error(`Text style has variable bindings: ${name}. Update its variables instead; sync will not detach them.`);
    }
    stylePlan.push({ name, spec: desired, existing, changed });
  }
  const changes = [
    ...variablePlan.map(p => ({ kind: 'variable', name: p.name, id: p.existing?.id ?? null, action: !p.existing ? 'create' : p.changed ? 'update' : 'unchanged',
      before: p.existing?.valuesByMode[modeId] ?? null, after: p.value })),
    ...stylePlan.map(p => ({ kind: 'textStyle', name: p.name, id: p.existing?.id ?? null, action: !p.existing ? 'create' : p.changed ? 'update' : 'unchanged',
      before: p.existing ? { fontName: p.existing.fontName, fontSize: p.existing.fontSize, lineHeight: p.existing.lineHeight } : null, after: p.spec })),
  ];
  const result = { collectionId: collection.id, modeId, dryRun: args.dryRun !== false, changes,
    note: 'Updates affect all layers bound to these resources. Omitted resources and non-default modes are preserved. Existing boards are reused; creation-time captions are not rewritten.' };
  if (args.dryRun !== false) return result;
  const changedStyles = stylePlan.filter(p => p.changed);
  // Validate fonts before making any change, including fonts needed for rollback.
  const fonts = new Map<string, FontName>();
  for (const plan of changedStyles) {
    for (const font of [plan.spec.fontName, plan.existing?.fontName]) if (font) fonts.set(JSON.stringify(font), font);
  }
  for (const font of fonts.values()) await figma.loadFontAsync(font);
  const created: (Variable | TextStyle)[] = [];
  const restore: (() => void)[] = [];
  let mutated = false;
  try {
    for (const plan of variablePlan.filter(p => p.changed)) {
      let variable = plan.existing;
      if (variable) {
        const previous = variable.valuesByMode[modeId];
        if (previous === undefined) throw new Error(`Default mode has no value for ${plan.name}`);
        const target = variable;
        restore.push(() => target.setValueForMode(modeId, previous));
      } else {
        variable = figma.variables.createVariable(plan.name, collection, plan.type);
        created.push(variable);
      }
      mutated = true;
      variable.setValueForMode(modeId, plan.value);
      changes.find(c => c.kind === 'variable' && c.name === plan.name)!.id = variable.id;
    }
    for (const plan of changedStyles) {
      let style = plan.existing;
      if (style) {
        const target = style;
        const previous = { fontName: style.fontName, fontSize: style.fontSize, lineHeight: style.lineHeight };
        restore.push(() => { target.fontName = previous.fontName; target.fontSize = previous.fontSize; target.lineHeight = previous.lineHeight; });
      } else {
        style = figma.createTextStyle();
        created.push(style);
        style.name = plan.name;
      }
      mutated = true;
      style.fontName = plan.spec.fontName;
      style.fontSize = plan.spec.fontSize;
      style.lineHeight = plan.spec.lineHeight;
      changes.find(c => c.kind === 'textStyle' && c.name === plan.name)!.id = style.id;
    }
    if (mutated) figma.commitUndo();
    return result;
  } catch (error) {
    let failures = 0;
    for (const undo of restore.reverse()) { try { undo(); } catch { failures++; } }
    for (const resource of created.reverse()) { try { resource.remove(); } catch { failures++; } }
    if (mutated) figma.commitUndo();
    throw new Error(`${error instanceof Error ? error.message : String(error)}. ${failures ? 'Rollback incomplete; inspect the design system or use Figma Undo.' : 'Sync changes rolled back; existing IDs preserved.'}`);
  }
}
