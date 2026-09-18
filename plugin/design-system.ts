import { createPageChecked, getCapabilities } from './capabilities';
import { variableResolver } from './variables';
import { syncGuide } from './sync-guide';
type Args = Record<string, any>;
type Helpers = {
  getNode(id: string): Promise<BaseNode>;
  applyProps(node: SceneNode, props: Args): Promise<void>;
  createNode(args: Args): Promise<SceneNode>;
};
export const designCommands = new Set(['create_style_guide', 'sync_style_guide', 'get_design_system', 'create_page', 'create_scene', 'create_instance', 'set_variable']);
const rgb = (hex: string): RGB => ({ r: parseInt(hex.slice(1, 3), 16) / 255,
  g: parseInt(hex.slice(3, 5), 16) / 255, b: parseInt(hex.slice(5, 7), 16) / 255 });

async function createGuide(args: Args, helpers: Helpers) {
  // Capture the destination before awaiting fonts: the user may switch pages meanwhile.
  const previousPage = figma.currentPage;
  const specifiedPage = args.pageId ? await helpers.getNode(args.pageId) : undefined;
  if (specifiedPage && specifiedPage.type !== 'PAGE') throw new Error('pageId must identify a page');
  const { name, colors, typography, spacing, radii } = args;
  const prefix = `${name}/`;
  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  const existingStyles = await figma.getLocalTextStylesAsync();
  if (collections.some(c => c.name === name) || existingStyles.some(s => s.name.startsWith(prefix)) ||
      figma.root.children.some(p => p.name === `${name} — Style guide`)) {
    throw new Error(`Design system '${name}' already exists. Use get_design_system and set_variable, or choose a new name.`);
  }
  // Resolve fonts before creating any resources, so a missing font leaves no partial guide.
  const fontNames: FontName[] = [{ family: 'Inter', style: 'Regular' }, { family: 'Inter', style: 'Bold' },
    ...typography.map((t: Args) => ({ family: t.fontFamily, style: t.fontStyle }))];
  const fonts = new Map(fontNames.map(font => [JSON.stringify(font), font]));
  for (const font of fonts.values()) await figma.loadFontAsync(font);
  let page: PageNode | undefined;
  let createdPage = false;
  let board: SceneNode | undefined;
  let collection: VariableCollection | undefined;
  const variables: Variable[] = [];
  const styles: TextStyle[] = [];
  try {
    // Resolve page capacity before making variables or styles. At the limit, use a board.
    if (specifiedPage) page = specifiedPage as PageNode;
    else if (!getCapabilities().canCreatePage) page = previousPage;
    else {
      try { page = createPageChecked(`${name} — Style guide`); createdPage = true; }
      catch (error) {
        if (error instanceof Error && error.message.startsWith('PAGE_LIMIT:')) page = previousPage;
        else throw error;
      }
    }
    await page.loadAsync();
    collection = figma.variables.createVariableCollection(name);
    const modeId = collection.defaultModeId;
    const createVariable = (tokenName: string, value: VariableValue, type: VariableResolvedDataType) => {
      const variable = figma.variables.createVariable(tokenName, collection!, type);
      variables.push(variable);
      variable.setValueForMode(modeId, value);
      return variable;
    };
    const colorTokens = colors.map((c: Args) => ({ ...c, variable: createVariable(`color/${c.name}`, rgb(c.value), 'COLOR') }));
    const spacingTokens = spacing.map((s: Args) => ({ ...s, variable: createVariable(`spacing/${s.name}`, s.value, 'FLOAT') }));
    const radiusTokens = radii.map((s: Args) => ({ ...s, variable: createVariable(`radius/${s.name}`, s.value, 'FLOAT') }));
    for (const spec of typography) {
      const style = figma.createTextStyle();
      styles.push(style);
      style.name = prefix + spec.name;
      style.fontName = { family: spec.fontFamily, style: spec.fontStyle };
      style.fontSize = spec.fontSize;
      style.lineHeight = spec.lineHeight ? { unit: 'PIXELS', value: spec.lineHeight } : { unit: 'AUTO' };
    }
    const create = (type: string, props: Args, parentId = page!.id) => helpers.createNode({ type, props, parentId });
    const rightEdge = page.children.reduce((edge, child) => Math.max(edge, child.x + child.width), 0);
    board = await create('FRAME', { name: `${name} / Foundations`, x: page.children.length ? rightEdge + 160 : 0, y: 0, width: 1120, height: 600,
      fill: '#FFFFFF', clipsContent: false });
    const label = (text: string, x: number, y: number, size = 14, bold = false) => create('TEXT', {
      name: text, characters: text, x, y, fontSize: size,
      fontName: { family: 'Inter', style: bold ? 'Bold' : 'Regular' },
      fill: '#0F172A', textAutoResize: 'HEIGHT', width: 980,
    }, board!.id);
    const title = await label(name, 48, 40, 40, true);
    const subtitleY = 40 + title.height + 16;
    const subtitle = await label('Style guide · Colors / Typography / Spacing / Radius', 48, subtitleY);
    let y = subtitleY + subtitle.height + 40;
    async function heading(title: string) {
      const node = await label(title, 48, y, 24, true);
      y += node.height + 24;
    }
    await heading('01 / Colors');
    for (const token of colorTokens) {
      await create('RECTANGLE', { name: token.name, x: 48, y, width: 64, height: 48,
        cornerRadius: 8, fillVariableId: token.variable.id, stroke: '#CBD5E1' }, board.id);
      const caption = await label(`${token.name}   ${token.value}`, 136, y + 10);
      await helpers.applyProps(caption, { width: 880 });
      y += Math.max(48, caption.height + 10) + 16;
    }
    y += 24;
    await heading('02 / Typography');
    for (let i = 0; i < styles.length; i++) {
      const spec = typography[i];
      const title = await label(`${spec.name} · ${spec.fontFamily} ${spec.fontStyle} · ${spec.fontSize}px`, 48, y);
      y += title.height + 12;
      const specimen = await create('TEXT', { name: spec.name, characters: 'The quick brown fox · 0123456789',
        textStyleId: styles[i].id, x: 48, y, width: 1000, textAutoResize: 'HEIGHT', fill: '#0F172A' }, board.id);
      y += specimen.height + 32;
    }
    await heading('03 / Spacing');
    for (const token of spacingTokens) {
      const title = await label(`${token.name} · ${token.value}px`, 48, y);
      y += title.height + 10;
      // Binding a gap also supports the zero token; zero-width rectangles do not.
      const row = await create('FRAME', { name: `spacing/${token.name}`, x: 48, y,
        width: 48 + token.value, height: 24, fill: null, layoutMode: 'HORIZONTAL', primaryAxisSizingMode: 'FIXED',
        itemSpacing: token.value, clipsContent: false, variableBindings: { itemSpacing: token.variable.id } }, board.id);
      for (let n = 0; n < 2; n++) await create('RECTANGLE', { name: 'Gap marker', width: 24, height: 24, fill: '#2563EB' }, row.id);
      y += 48;
    }
    await heading('04 / Radius');
    for (const token of radiusTokens) {
      await create('RECTANGLE', { name: `radius/${token.name}`, x: 48, y, width: 80, height: 56, fill: '#DBEAFE',
        variableBindings: { topLeftRadius: token.variable.id, topRightRadius: token.variable.id,
          bottomLeftRadius: token.variable.id, bottomRightRadius: token.variable.id } }, board.id);
      const caption = await label(`${token.name} · ${token.value}px`, 152, y + 16);
      await helpers.applyProps(caption, { width: 880 });
      y += Math.max(56, caption.height + 16) + 20;
    }
    await helpers.applyProps(board, { width: 1120, height: y + 48 });
    figma.commitUndo();
    return { pageId: page.id, frameId: board.id, createdPage, capabilities: getCapabilities(), collectionId: collection.id, modeId,
      colors: colorTokens.map((t: Args) => ({ name: t.name, id: t.variable.id, value: t.value })),
      spacing: spacingTokens.map((t: Args) => ({ name: t.name, id: t.variable.id, value: t.value })),
      radii: radiusTokens.map((t: Args) => ({ name: t.name, id: t.variable.id, value: t.value })),
      textStyles: styles.map(style => ({ id: style.id, name: style.name })),
      note: 'Specimens are bound to variables/styles. Numeric/hex captions describe creation-time values. Use get_design_system for current values.' };
  } catch (error) {
    // Delete only resources made by this call. Report any failed cleanup explicitly.
    const failures: string[] = [];
    if (createdPage && page && figma.currentPage.id === page.id) {
      try { await figma.setCurrentPageAsync(previousPage); } catch { failures.push('restore current page'); }
    }
    for (const resource of [createdPage ? page : board, ...styles, ...variables, collection]) {
      if (!resource) continue;
      try { resource.remove(); } catch { failures.push(resource.id); }
    }
    throw new Error(`${error instanceof Error ? error.message : String(error)}. ${failures.length ? `Cleanup incomplete: ${failures.join(', ')}` : 'New guide resources cleaned up.'}`);
  }
}

export async function executeDesignCommand(command: string, args: Args, helpers: Helpers): Promise<any> {
  switch (command) {
    case 'create_style_guide': return createGuide(args, helpers);
    case 'sync_style_guide': return syncGuide(args);
    case 'get_design_system': {
      const collections = await figma.variables.getLocalVariableCollectionsAsync();
      const selected = collections.filter(c => c.name.startsWith(args.prefix));
      const ids = new Set(selected.map(c => c.id));
      const variables = (await figma.variables.getLocalVariablesAsync()).filter(v => ids.has(v.variableCollectionId));
      const styles = (await figma.getLocalTextStylesAsync()).filter(s => s.name.startsWith(args.prefix));
      return { collections: selected.slice(0, args.limit).map(c => ({ id: c.id, name: c.name, modes: c.modes, defaultModeId: c.defaultModeId })),
        variables: variables.slice(0, args.limit).map(v => ({ id: v.id, name: v.name, type: v.resolvedType, collectionId: v.variableCollectionId, valuesByMode: v.valuesByMode })),
        textStyles: styles.slice(0, args.limit).map(s => ({ id: s.id, name: s.name, fontName: s.fontName, fontSize: s.fontSize, lineHeight: s.lineHeight })),
        truncated: selected.length > args.limit || variables.length > args.limit || styles.length > args.limit };
    }
    case 'create_page': {
      const matches = figma.root.children.filter(p => p.name === args.name);
      if (matches.length > 1) throw new Error('Several pages have this name. Use get_document and an explicit page ID.');
      if (matches.length === 1) return { id: matches[0].id, name: matches[0].name, reused: true, capabilities: getCapabilities() };
      const page = createPageChecked(args.name);
      figma.commitUndo();
      return { id: page.id, name: page.name, reused: false, capabilities: getCapabilities() };
    }
    case 'create_scene': {
      const rootParentId = args.parentId ?? figma.currentPage.id;
      const refs = new Map<string, SceneNode>();
      const repaired: string[] = [];
      try {
        for (const spec of args.nodes) {
          if (refs.has(spec.ref) || (spec.parentRef && !refs.has(spec.parentRef))) throw new Error('Invalid scene references');
          const parentId = spec.parentRef ? refs.get(spec.parentRef)!.id : rootParentId;
          const node = await helpers.createNode({ type: spec.type, parentId, props: spec.props });
          refs.set(spec.ref, node);
        }
        // Dynamic-page files can occasionally report a stale layer relation after a batch edit.
        // Verify every expected parent before success; repair only into non-auto-layout containers.
        for (const spec of args.nodes) {
          const node = refs.get(spec.ref)!;
          const expectedId = spec.parentRef ? refs.get(spec.parentRef)!.id : rootParentId;
          if (node.parent?.id === expectedId) continue;
          const expected = await helpers.getNode(expectedId);
          if (!['PAGE', 'FRAME', 'COMPONENT', 'SECTION'].includes(expected.type)) throw new Error(`Invalid expected parent for ${spec.ref}`);
          if (expected.type !== 'PAGE' && (expected as any).layoutMode !== 'NONE') {
            throw new Error(`Hierarchy verification failed for ${spec.ref}: destination uses auto layout`);
          }
          const bounds = node.absoluteBoundingBox ?? { x: node.x, y: node.y };
          const parentBounds = expected.type === 'PAGE' ? { x: 0, y: 0 } : ((expected as SceneNode).absoluteBoundingBox ?? { x: 0, y: 0 });
          (expected as ChildrenMixin).appendChild(node);
          node.x = bounds.x - parentBounds.x;
          node.y = bounds.y - parentBounds.y;
          if (node.parent?.id !== expectedId) throw new Error(`Hierarchy recovery failed for ${spec.ref}`);
          repaired.push(spec.ref);
        }
        figma.commitUndo();
        return { nodes: Array.from(refs, ([ref, node]) => ({ ref, id: node.id, type: node.type, name: node.name })), hierarchyVerified: true, repaired };
      } catch (error) {
        const failures: string[] = [];
        for (const node of [...refs.values()].reverse()) {
          try { if (!node.removed) node.remove(); } catch { failures.push(node.id); }
        }
        throw new Error(`${error instanceof Error ? error.message : String(error)}. ${failures.length ? `Cleanup incomplete: ${failures.join(', ')}` : 'New scene nodes cleaned up.'}`);
      }
    }
    case 'create_instance': {
      const component = await helpers.getNode(args.componentId);
      if (component.type !== 'COMPONENT') throw new Error('componentId must refer to a local COMPONENT');
      const parent = args.parentId ? await helpers.getNode(args.parentId) : figma.currentPage;
      if (!['PAGE', 'FRAME', 'COMPONENT', 'SECTION'].includes(parent.type)) throw new Error('Unsupported instance parent');
      // Instances cannot be inserted into their own component or its descendants.
      let ancestor: BaseNode | null = parent;
      while (ancestor) {
        if (ancestor.id === component.id) throw new Error('Cannot nest an instance inside its own component');
        ancestor = ancestor.parent;
      }
      const instance = component.createInstance();
      try {
        (parent as ChildrenMixin).appendChild(instance);
        await helpers.applyProps(instance, args.props);
        figma.commitUndo();
        return { id: instance.id, componentId: component.id, name: instance.name };
      } catch (error) { instance.remove(); throw error; }
    }
    case 'set_variable': {
      const variable = await variableResolver()(args.variableId, true);
      if (!variable || variable.remote) throw new Error('Local variable not found');
      const collection = (await figma.variables.getLocalVariableCollectionsAsync()).find(c => c.id === variable.variableCollectionId);
      if (!collection) throw new Error('Variable collection not found');
      const modeId = args.modeId ?? collection.defaultModeId;
      if (!collection.modes.some(m => m.modeId === modeId)) throw new Error('Mode does not belong to this collection');
      let value: VariableValue;
      if (variable.resolvedType === 'COLOR' && typeof args.value === 'string' && /^#[0-9a-fA-F]{6}$/.test(args.value)) value = rgb(args.value);
      else if (variable.resolvedType === 'FLOAT' && typeof args.value === 'number' && Number.isFinite(args.value)) value = args.value;
      else throw new Error('Value must match the variable type: COLOR #RRGGBB or FLOAT number');
      variable.setValueForMode(modeId, value);
      figma.commitUndo();
      return { id: variable.id, name: variable.name, modeId, value };
    }
    default: throw new Error(`Unknown design command: ${command}`);
  }
}
