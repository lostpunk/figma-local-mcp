type Args = Record<string, any>;
type Helpers = { getNode(id: string): Promise<BaseNode> };
export const extendedCommands = new Set(['import_image', 'import_svg', 'create_component_set',
  'set_instance_properties', 'set_prototype_link', 'set_prototype_start', 'move_component']);

function pageOf(node: BaseNode): PageNode {
  let current: BaseNode | null = node;
  while (current && current.type !== 'PAGE') current = current.parent;
  if (!current) throw new Error('Node must belong to a page');
  return current as PageNode;
}
async function parentFor(args: Args, helpers: Helpers): Promise<BaseNode & ChildrenMixin> {
  const parent = await helpers.getNode(args.parentId ?? figma.currentPage.id);
  if (!['PAGE', 'FRAME', 'COMPONENT', 'SECTION'].includes(parent.type)) throw new Error('Unsupported parent');
  return parent as BaseNode & ChildrenMixin;
}
function result(node: SceneNode) {
  return { id: node.id, name: node.name, type: node.type, parentId: node.parent?.id,
    x: node.x, y: node.y, width: node.width, height: node.height };
}

export async function executeExtended(command: string, args: Args, helpers: Helpers): Promise<any> {
  switch (command) {
    case 'move_component': {
      const node = await helpers.getNode(args.nodeId);
      const parent = await helpers.getNode(args.parentId);
      if (node.type !== 'COMPONENT' && node.type !== 'COMPONENT_SET') throw new Error('Move a COMPONENT or whole COMPONENT_SET');
      if (node.remote) throw new Error('Cannot move a remote component');
      if (!['PAGE', 'FRAME', 'SECTION'].includes(parent.type)) throw new Error('Destination must be PAGE, FRAME or SECTION');
      if (!Number.isFinite(args.x) || !Number.isFinite(args.y)) throw new Error('Explicit finite destination x/y are required');
      for (let a = node.parent; a; a = a.parent) {
        if (['INSTANCE', 'COMPONENT', 'COMPONENT_SET'].includes(a.type)) throw new Error('Move the whole component set or outer component; nested components cannot be extracted');
      }
      for (let a: BaseNode | null = parent; a; a = a.parent) {
        if (a.id === node.id) throw new Error('Cannot move a component into its descendant');
        if (['INSTANCE', 'COMPONENT', 'COMPONENT_SET'].includes(a.type)) throw new Error('Destination cannot be inside a component or instance');
      }
      const previous = { parentId: node.parent?.id, x: node.x, y: node.y };
      try {
        (parent as BaseNode & ChildrenMixin).appendChild(node);
        node.x = args.x; node.y = args.y;
        figma.commitUndo();
        return { ...result(node), previous, preservedId: true };
      } catch (error) {
        throw new Error(`${error instanceof Error ? error.message : String(error)}. Move may be partial; inspect ${node.id} or use Figma Undo.`);
      }
    }
    case 'import_image': {
      const parent = args.nodeId ? undefined : await parentFor(args, helpers);
      const target = args.nodeId ? await helpers.getNode(args.nodeId) : undefined;
      if (target && (target.type === 'PAGE' || target.type === 'DOCUMENT' || !('fills' in target))) throw new Error('nodeId must have editable fills');
      if (target && target.type === 'TEXT') throw new Error('Use a shape or frame as an image target');
      if (typeof args.dataBase64 !== 'string' || args.dataBase64.length > 11184812) throw new Error('Image payload is missing or too large');
      const bytes = figma.base64Decode(args.dataBase64);
      if (!bytes.length || bytes.length > 8 * 1024 * 1024) throw new Error('Image exceeds 8 MiB');
      const image = figma.createImage(bytes);
      const original = await image.getSizeAsync();
      if (original.width > 4096 || original.height > 4096) throw new Error('Image exceeds 4096 pixels per side; resize it first');
      const fill: ImagePaint = { type: 'IMAGE', imageHash: image.hash, scaleMode: args.scaleMode };
      let node: SceneNode | undefined;
      if (target && 'fills' in target) {
        target.fills = [fill];
        node = target as SceneNode;
      } else {
        const created = figma.createRectangle();
        try {
          parent!.appendChild(created);
          const width = args.width ?? (args.height ? args.height * original.width / original.height : original.width);
          const height = args.height ?? width * original.height / original.width;
          created.resize(width, height);
          created.x = args.x ?? 0; created.y = args.y ?? 0;
          created.name = args.name ?? 'Image'; created.fills = [fill]; node = created;
        } catch (error) { created.remove(); throw error; }
      }
      figma.commitUndo();
      return { ...result(node!), imageHash: image.hash, original, replacedFill: !!target };
    }
    case 'import_svg': {
      const parent = await parentFor(args, helpers);
      if (typeof args.svg !== 'string' || args.svg.length > 1048576) throw new Error('SVG is missing or too large');
      const node = figma.createNodeFromSvg(args.svg);
      try {
        parent.appendChild(node);
        if (args.width !== undefined) {
          if (node.width <= 0) throw new Error('SVG has no usable width');
          node.rescale(args.width / node.width);
        }
        node.name = args.name ?? 'SVG'; node.x = args.x ?? 0; node.y = args.y ?? 0;
        figma.commitUndo(); return { ...result(node), childCount: node.children.length };
      } catch (error) { node.remove(); throw error; }
    }
    case 'create_component_set': {
      const parent = await parentFor(args, helpers);
      const sources: ComponentNode[] = [];
      for (const variant of args.variants) {
        const node = await helpers.getNode(variant.componentId);
        if (node.type !== 'COMPONENT' || node.remote) throw new Error('Each source must be a local COMPONENT');
        let ancestor: BaseNode | null = parent;
        while (ancestor) {
          if (ancestor.id === node.id) throw new Error('Cannot create variants inside their own source component');
          ancestor = ancestor.parent;
        }
        sources.push(node);
      }
      const clones: ComponentNode[] = [];
      let set: ComponentSetNode | undefined;
      try {
        for (let i = 0; i < sources.length; i++) {
          const clone = sources[i].clone(); clones.push(clone); parent.appendChild(clone);
          clone.name = Object.keys(args.variants[i].properties).sort().map(key => `${key}=${args.variants[i].properties[key]}`).join(', ');
        }
        set = figma.combineAsVariants(clones, parent);
        set.name = args.name; set.layoutMode = 'HORIZONTAL'; set.itemSpacing = args.spacing;
        set.paddingTop = set.paddingBottom = set.paddingLeft = set.paddingRight = 24;
        set.primaryAxisSizingMode = 'AUTO'; set.counterAxisSizingMode = 'AUTO';
        set.x = args.x; set.y = args.y;
        figma.commitUndo();
        return { ...result(set), componentPropertyDefinitions: set.componentPropertyDefinitions,
          variants: clones.map((node, i) => ({ id: node.id, sourceComponentId: sources[i].id, properties: args.variants[i].properties })),
          note: 'Variant components are copies; source components and their instances are unchanged.' };
      } catch (error) {
        const failures: string[] = [];
        for (const node of [...clones, set]) if (node && !node.removed) {
          try { node.remove(); } catch { failures.push(node.id); }
        }
        throw new Error(`${error instanceof Error ? error.message : String(error)}. ${failures.length ? 'Cleanup incomplete: ' + failures.join(', ') : 'New variant resources cleaned up.'}`);
      }
    }
    case 'set_instance_properties': {
      const node = await helpers.getNode(args.nodeId);
      if (node.type !== 'INSTANCE') throw new Error('nodeId must be an INSTANCE');
      const main = await node.getMainComponentAsync();
      if (!main) throw new Error('Main component is unavailable');
      const definitions = main.parent?.type === 'COMPONENT_SET' ? main.parent.componentPropertyDefinitions : main.componentPropertyDefinitions;
      for (const [key, value] of Object.entries(args.properties)) {
        const def = definitions[key];
        if (!def || !node.componentProperties[key]) throw new Error(`Unknown property: ${key}. Use exact names from get_node.`);
        if (def.type === 'BOOLEAN' ? typeof value !== 'boolean' : typeof value !== 'string') throw new Error(`Invalid value type for ${key}`);
        if (def.type === 'VARIANT' && !def.variantOptions?.includes(value as string)) throw new Error(`Unknown variant value for ${key}`);
        if (!['BOOLEAN', 'TEXT', 'VARIANT'].includes(def.type)) throw new Error('Only BOOLEAN, TEXT and VARIANT properties are supported');
      }
      // Text overrides can touch several descendants; resolve fonts before any mutation.
      if (Object.keys(args.properties).some(key => definitions[key].type === 'TEXT')) {
        const texts = node.findAllWithCriteria({ types: ['TEXT'] });
        for (const text of texts) {
          const fonts = text.characters.length ? [...text.getRangeAllFontNames(0, text.characters.length)] : [];
          if (text.fontName !== figma.mixed) fonts.push(text.fontName);
          for (const font of fonts) await figma.loadFontAsync(font);
        }
      }
      try { node.setProperties(args.properties); }
      catch (error) { figma.commitUndo(); throw new Error(`${String(error)}. Inspect the instance or use Undo; overrides may have changed.`); }
      figma.commitUndo();
      return { id: node.id, componentProperties: node.componentProperties, variantProperties: node.variantProperties };
    }
    case 'set_prototype_link': {
      const node = await helpers.getNode(args.nodeId);
      if (!('setReactionsAsync' in node)) throw new Error('Source node does not support prototype reactions');
      const previous = [...node.reactions];
      const matching = previous.filter(r => r.trigger?.type === args.trigger);
      if (matching.length && !args.replaceExisting) throw new Error('This trigger already has reactions. Inspect get_node; set replaceExisting=true to replace only this trigger.');
      let action: Action;
      if (args.action === 'BACK' || args.action === 'CLOSE') {
        if (args.destinationId || args.transition !== 'INSTANT') throw new Error('BACK/CLOSE do not accept a destination or transition');
        action = { type: args.action };
      } else {
        if (!args.destinationId) throw new Error('destinationId is required');
        const destination = await helpers.getNode(args.destinationId);
        if (pageOf(destination).id !== pageOf(node).id) throw new Error('Prototype source and destination must be on the same page');
        if (args.action === 'CHANGE_TO') {
          let component: BaseNode | null = node;
          while (component && component.type !== 'COMPONENT') component = component.parent;
          if (!component || component.parent?.type !== 'COMPONENT_SET' || destination.type !== 'COMPONENT' || destination.parent?.id !== component.parent.id || destination.id === component.id) {
            throw new Error('CHANGE_TO requires different variants in the same component set');
          }
        } else if (destination.type !== 'FRAME' || destination.parent?.type !== 'PAGE') {
          throw new Error('NAVIGATE/OVERLAY destination must be a top-level FRAME');
        }
        if (args.action === 'NAVIGATE') {
          let ancestor: BaseNode | null = node;
          while (ancestor && ancestor.type !== 'PAGE') {
            if (ancestor.id === destination.id) {
              throw new Error('NAVIGATE destination must be a different screen from the source. No reactions were changed.');
            }
            ancestor = ancestor.parent;
          }
        }
        action = { type: 'NODE', destinationId: destination.id, navigation: args.action,
          transition: args.transition === 'INSTANT' ? null : { type: args.transition, easing: { type: 'EASE_OUT' }, duration: args.durationMs / 1000 },
          resetScrollPosition: true };
      }
      const reactions = [...previous.filter(r => r.trigger?.type !== args.trigger), { trigger: { type: args.trigger }, actions: [action] }];
      try { await node.setReactionsAsync(reactions); }
      catch (error) { figma.commitUndo(); throw new Error(`${String(error)}. Inspect reactions or use Undo before retrying.`); }
      figma.commitUndo(); return { id: node.id, reactions: node.reactions };
    }
    case 'set_prototype_start': {
      const frame = await helpers.getNode(args.frameId);
      if (frame.type !== 'FRAME' || frame.parent?.type !== 'PAGE') throw new Error('Prototype start must be a top-level FRAME');
      const page = frame.parent;
      const starts = page.flowStartingPoints.filter(s => s.nodeId !== frame.id);
      if (starts.some(s => s.name === args.name)) throw new Error('A different prototype flow already uses this name');
      page.flowStartingPoints = [...starts, { nodeId: frame.id, name: args.name }];
      figma.commitUndo(); return { pageId: page.id, flowStartingPoints: page.flowStartingPoints };
    }
    default: throw new Error(`Unknown extended command: ${command}`);
  }
}
