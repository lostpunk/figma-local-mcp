import { designCommands, executeDesignCommand } from './design-system';
import { getCapabilities, setDeclaredPlan } from './capabilities';
type Args = Record<string, any>;
type Json = Record<string, any>;
const properties = [
  'x', 'y', 'width', 'height', 'rotation', 'visible', 'locked', 'opacity',
  'absoluteBoundingBox', 'absoluteRenderBounds', 'relativeTransform',
  'fills', 'strokes', 'strokeWeight', 'cornerRadius', 'effects',
  'characters', 'fontName', 'fontSize', 'textAlignHorizontal', 'textAlignVertical',
  'lineHeight', 'letterSpacing', 'textAutoResize', 'layoutMode',
  'layoutSizingHorizontal', 'layoutSizingVertical', 'layoutGrow', 'layoutAlign',
  'itemSpacing', 'paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight',
  'primaryAxisAlignItems', 'counterAxisAlignItems', 'primaryAxisSizingMode',
  'counterAxisSizingMode', 'clipsContent', 'constraints', 'boundVariables',
  'componentProperties', 'textStyleId',
];

function clean(value: any): any {
  if (value === figma.mixed) return { mixed: true };
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value, (_key, v) => typeof v === 'symbol' ? { mixed: true } : v));
}
function summarize(node: BaseNode, depth: number, budget: { left: number }): Json {
  budget.left--;
  const result: Json = { id: node.id, type: node.type, name: node.name, parentId: node.parent?.id };
  const source = node as any;
  for (const key of properties) {
    if (key in node) {
      const value = source[key];
      if (key === 'characters' && typeof value === 'string' && value.length > 10000) {
        result[key] = value.slice(0, 10000);
        result.charactersTruncated = true;
        result.characterCount = value.length;
      } else result[key] = clean(value);
    }
  }
  if ('children' in node) {
    const children = (node as ChildrenMixin).children;
    result.childCount = children.length;
    result.children = [];
    if (depth > 0) {
      for (const child of children) {
        if (budget.left <= 0) break;
        result.children.push(summarize(child, depth - 1, budget));
      }
    }
    result.childrenTruncated = result.children.length < children.length;
  }
  return result;
}
async function getNode(id: string): Promise<BaseNode> {
  const node = await figma.getNodeByIdAsync(id);
  if (!node || node.removed) throw new Error(`Node not found: ${id}`);
  if (node.type === 'PAGE') await node.loadAsync();
  if (node.type === 'DOCUMENT') throw new Error('Use get_document for document metadata; get_node accepts a page or scene node.');
  return node;
}
function requireScene(node: BaseNode): SceneNode {
  if (node.type === 'DOCUMENT' || node.type === 'PAGE') throw new Error('This operation requires a scene node.');
  return node;
}
function requireContainer(node: BaseNode): BaseNode & ChildrenMixin {
  if (!['PAGE', 'FRAME', 'COMPONENT', 'SECTION'].includes(node.type)) {
    throw new Error('Parent must be PAGE, FRAME, COMPONENT or SECTION');
  }
  return node as BaseNode & ChildrenMixin;
}
function pageOf(node: BaseNode): PageNode {
  let parent: BaseNode | null = node;
  while (parent && parent.type !== 'PAGE') parent = parent.parent;
  if (!parent) throw new Error('Node is not attached to a page');
  return parent as PageNode;
}
const textProperties = ['characters', 'fontName', 'fontSize', 'textAlignHorizontal', 'textAutoResize', 'lineHeight'];
const writable = new Set([
  'name', 'x', 'y', 'width', 'height', 'rotation', 'opacity', 'visible', 'locked',
  'fill', 'stroke', 'strokeWeight', 'cornerRadius', ...textProperties,
  'layoutMode', 'itemSpacing', 'paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight',
  'primaryAxisAlignItems', 'counterAxisAlignItems', 'primaryAxisSizingMode', 'counterAxisSizingMode', 'clipsContent',
  'textStyleId', 'fillVariableId', 'strokeVariableId', 'variableBindings',
]);
function paint(hex: string | null): Paint[] {
  if (hex === null) return [];
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) throw new Error('Color must be #RRGGBB');
  return [{ type: 'SOLID', color: {
    r: parseInt(hex.slice(1, 3), 16) / 255,
    g: parseInt(hex.slice(3, 5), 16) / 255,
    b: parseInt(hex.slice(5, 7), 16) / 255,
  } }];
}
type ImageDecodeRequest = { resolve(base64: string): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };
const imageDecodeRequests = new Map<string, ImageDecodeRequest>();
function decodeImageToPng(base64: string, mimeType?: string): Promise<string> {
  const id = `image-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      imageDecodeRequests.delete(id);
      reject(new Error('Image normalization timed out in the Figma plugin UI'));
    }, 30000);
    imageDecodeRequests.set(id, { resolve, reject, timer });
    figma.ui.postMessage({ type: 'decode-image', id, base64, mimeType: mimeType ?? 'application/octet-stream' });
  });
}
async function createFigmaImage(base64: string, mimeType?: string): Promise<{ image: Image; normalized: boolean }> {
  if (mimeType !== 'image/webp') {
    try { return { image: figma.createImage(figma.base64Decode(base64)), normalized: false }; }
    catch { /* Normalize browser-decodable files that Figma rejects directly. */ }
  }
  const png = await decodeImageToPng(base64, mimeType);
  try { return { image: figma.createImage(figma.base64Decode(png)), normalized: true }; }
  catch (error) { throw new Error(`Figma could not create the normalized image: ${error instanceof Error ? error.message : String(error)}`); }
}
async function applyProps(node: SceneNode, props: Args) {
  const target = node as any;
  const special = ['textStyleId', 'fillVariableId', 'strokeVariableId', 'variableBindings'];
  let textStyle: TextStyle | undefined;
  if (props.textStyleId) {
    if (node.type !== 'TEXT') throw new Error('textStyleId requires TEXT');
    const style = await figma.getStyleByIdAsync(props.textStyleId);
    if (!style || style.type !== 'TEXT') throw new Error('Text style not found');
    textStyle = style;
    if (['fontName', 'fontSize', 'lineHeight'].some(k => props[k] !== undefined)) throw new Error('Use textStyleId or explicit typography properties in one call');
  }
  const bindings: { field: string; variable: Variable | null }[] = [];
  for (const [field, variableId] of Object.entries(props.variableBindings ?? {})) {
    if (!(field in node)) throw new Error(`Variable binding ${field} is not supported on ${node.type}`);
    const variable = variableId === null ? null : await figma.variables.getVariableByIdAsync(variableId as string);
    if (variableId !== null && (!variable || variable.resolvedType !== 'FLOAT')) throw new Error(`FLOAT variable not found for ${field}`);
    bindings.push({ field, variable });
  }
  const paints: Record<string, Paint[]> = {};
  for (const [key, field, raw] of [['fillVariableId', 'fills', 'fill'], ['strokeVariableId', 'strokes', 'stroke']]) {
    if (!props[key]) continue;
    if (!(field in node)) throw new Error(`${field} is not supported on ${node.type}`);
    if (props[raw] !== undefined) throw new Error(`Use ${key} or ${raw} in one call`);
    const variable = await figma.variables.getVariableByIdAsync(props[key]);
    if (!variable || variable.resolvedType !== 'COLOR') throw new Error(`COLOR variable not found: ${props[key]}`);
    paints[field] = [figma.variables.setBoundVariableForPaint({ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }, 'color', variable)];
  }
  // Check all supported fields before mutating, and load fonts before edits.
  for (const key of Object.keys(props)) {
    if (!writable.has(key)) throw new Error(`Unsupported property: ${key}`);
    if (special.includes(key)) continue;
    const actual = key === 'fill' ? 'fills' : key === 'stroke' ? 'strokes' : key;
    if (!(actual in node)) throw new Error(`${key} is not supported on ${node.type}`);
    if (textProperties.includes(key) && node.type !== 'TEXT') throw new Error(`${key} requires TEXT`);
  }
  if (node.type === 'TEXT' && Object.keys(props).some(k => textProperties.includes(k) || k === 'width' || k === 'height' || k === 'textStyleId' || k === 'variableBindings')) {
    const fonts = node.characters.length ? [...node.getRangeAllFontNames(0, node.characters.length)] : [];
    if (node.fontName !== figma.mixed) fonts.push(node.fontName);
    if (props.fontName) fonts.push(props.fontName);
    if (textStyle) fonts.push(textStyle.fontName);
    const unique = new Map(fonts.map(font => [JSON.stringify(font), font]));
    for (const font of unique.values()) await figma.loadFontAsync(font);
  }
  if (textStyle && node.type === 'TEXT') await node.setTextStyleIdAsync(textStyle.id);
  if (props.fontName) target.fontName = props.fontName;
  if (props.layoutMode !== undefined) target.layoutMode = props.layoutMode;
  for (const [key, value] of Object.entries(props)) {
    if (['width', 'height', 'fontName', 'layoutMode', 'x', 'y', 'locked', ...special].includes(key)) continue;
    if (key === 'fill') target.fills = paint(value);
    else if (key === 'stroke') target.strokes = paint(value);
    else target[key] = value;
  }
  if (props.width !== undefined || props.height !== undefined) {
    if (!('resize' in node)) throw new Error(`Resize is not supported on ${node.type}`);
    node.resize(props.width ?? node.width, props.height ?? node.height);
  }
  if (props.x !== undefined) node.x = props.x;
  if (props.y !== undefined) node.y = props.y;
  if (props.locked !== undefined) node.locked = props.locked;
  for (const [field, value] of Object.entries(paints)) target[field] = value;
  for (const binding of bindings) node.setBoundVariable(binding.field as VariableBindableNodeField, binding.variable);
}

async function createNode(args: Args): Promise<SceneNode> {
  const parent = args.parentId ? await getNode(args.parentId) : figma.currentPage;
  if (!['PAGE', 'FRAME', 'COMPONENT', 'SECTION'].includes(parent.type)) throw new Error('Parent must be PAGE, FRAME, COMPONENT or SECTION');
  if (args.type === 'TEXT') await figma.loadFontAsync(args.props.fontName ?? { family: 'Inter', style: 'Regular' });
  const creators: Record<string, () => SceneNode> = {
    FRAME: () => figma.createFrame(), RECTANGLE: () => figma.createRectangle(),
    ELLIPSE: () => figma.createEllipse(), TEXT: () => figma.createText(), COMPONENT: () => figma.createComponent(),
  };
  if (!creators[args.type]) throw new Error('Unsupported node type');
  const node = creators[args.type]();
  try {
    (parent as ChildrenMixin).appendChild(node);
    if (node.type === 'TEXT') node.fontName = args.props.fontName ?? { family: 'Inter', style: 'Regular' };
    await applyProps(node, args.props);
    return node;
  } catch (error) { node.remove(); throw error; }
}
async function execute(command: string, args: Args): Promise<any> {
  if (designCommands.has(command)) return executeDesignCommand(command, args, { getNode, applyProps, createNode });
  const budget = { left: args.maxNodes ?? 200 };
  switch (command) {
    case 'get_document':
      return { name: figma.root.name, currentPageId: figma.currentPage.id,
        pages: figma.root.children.map(p => ({ id: p.id, name: p.name })), capabilities: getCapabilities() };
    case 'get_selection': {
      const nodes = [];
      for (const node of figma.currentPage.selection) {
        if (budget.left <= 0) break;
        nodes.push(summarize(node, args.depth, budget));
      }
      return { nodes, selectionCount: figma.currentPage.selection.length,
        selectionTruncated: nodes.length < figma.currentPage.selection.length };
    }
    case 'get_node': return summarize(await getNode(args.nodeId), args.depth, budget);
    case 'find_nodes': {
      const page = args.pageId ? await getNode(args.pageId) : figma.currentPage;
      if (page.type !== 'PAGE') throw new Error('pageId must identify a page');
      // Iterators keep memory proportional to nesting rather than page size.
      const stack: Iterator<SceneNode>[] = [page.children[Symbol.iterator]()];
      const nodes: Json[] = [];
      let index = 0;
      let visited = 0;
      const query = args.query.toLocaleLowerCase();
      while (stack.length) {
        const next = stack[stack.length - 1].next();
        if (next.done) { stack.pop(); continue; }
        const node = next.value;
        if ('children' in node) stack.push(node.children[Symbol.iterator]());
        if (index++ < args.offset) continue;
        visited++;
        const matches = !args.type || node.type === args.type;
        if (matches && (node.name.toLocaleLowerCase().includes(query) ||
            (node.type === 'TEXT' && node.characters.toLocaleLowerCase().includes(query)))) {
          nodes.push({ id: node.id, name: node.name, type: node.type });
        }
        if (nodes.length >= args.limit || visited >= args.maxVisited) {
          return { nodes, visited, nextOffset: index, complete: false };
        }
      }
      return { nodes, visited, nextOffset: null, complete: true };
    }
    case 'create_node': {
      const node = await createNode(args);
      figma.commitUndo();
      return summarize(node, 0, { left: 1 });
    }
    case 'update_node': {
      const node = requireScene(await getNode(args.nodeId));
      try { await applyProps(node, args.props); }
      catch (error) {
        figma.commitUndo();
        throw new Error(`${error instanceof Error ? error.message : String(error)}. Some properties may have changed; inspect the node or use Figma Undo.`);
      }
      figma.commitUndo();
      return summarize(node, 0, { left: 1 });
    }
    case 'update_page': {
      const page = await getNode(args.pageId);
      if (page.type !== 'PAGE') throw new Error('pageId must identify a page');
      if (args.name !== undefined) page.name = args.name;
      if (args.background !== undefined) page.backgrounds = paint(args.background);
      figma.commitUndo();
      return { id: page.id, name: page.name, backgrounds: clean(page.backgrounds) };
    }
    case 'reparent_nodes': {
      const parent = requireContainer(await getNode(args.parentId));
      const nodes: SceneNode[] = [];
      const seen = new Set<string>();
      for (const id of args.nodeIds) {
        if (seen.has(id)) throw new Error(`Duplicate node id: ${id}`);
        const node = requireScene(await getNode(id));
        if (node.id === parent.id) throw new Error('A node cannot be its own parent');
        seen.add(id);
        nodes.push(node);
      }
      const page = pageOf(parent);
      if (nodes.some(node => pageOf(node).id !== page.id)) throw new Error('All nodes and the parent must belong to the same page');
      let ancestor: BaseNode | null = parent;
      while (ancestor) {
        if (seen.has(ancestor.id)) throw new Error('Cannot move a node into its own descendant');
        ancestor = ancestor.parent;
      }
      if (parent.type !== 'PAGE' && (parent as any).layoutMode && (parent as any).layoutMode !== 'NONE') {
        throw new Error('Destination uses auto layout; move into a non-auto-layout frame to preserve positioning');
      }
      const parentBox = parent.type === 'PAGE' ? { x: 0, y: 0 } : ((parent as SceneNode).absoluteBoundingBox ?? { x: 0, y: 0 });
      const positions = nodes.map(node => {
        const box = node.absoluteBoundingBox ?? { x: node.x, y: node.y };
        return { node, x: box.x, y: box.y };
      });
      const selected = new Set(nodes.map(node => node.id));
      const remaining = parent.children.filter(node => !selected.has(node.id));
      const insertIndex = Math.min(args.insertIndex ?? remaining.length, remaining.length);
      for (let i = 0; i < positions.length; i++) {
        const item = positions[i];
        const maxIndex = parent.children.length - (item.node.parent?.id === parent.id ? 1 : 0);
        parent.insertChild(Math.min(insertIndex + i, maxIndex), item.node);
        if (args.preserveAbsolutePosition !== false) {
          item.node.x = item.x - parentBox.x;
          item.node.y = item.y - parentBox.y;
        }
      }
      figma.commitUndo();
      return { parentId: parent.id, moved: nodes.map(node => node.id), insertIndex, preservedAbsolutePosition: args.preserveAbsolutePosition !== false };
    }
    case 'reorder_nodes': {
      const parent = requireContainer(await getNode(args.parentId));
      const selected = new Set<string>();
      const nodes: SceneNode[] = [];
      for (const id of args.nodeIds) {
        if (selected.has(id)) throw new Error(`Duplicate node id: ${id}`);
        const node = requireScene(await getNode(id));
        if (node.parent?.id !== parent.id) throw new Error('Every node must be a direct child of parentId');
        selected.add(id);
        nodes.push(node);
      }
      const remaining = parent.children.filter(node => !selected.has(node.id));
      const index = Math.min(args.index, remaining.length);
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        parent.insertChild(Math.min(index + i, parent.children.length - 1), node);
      }
      figma.commitUndo();
      return { parentId: parent.id, nodeIds: nodes.map(node => node.id), index };
    }
    case 'set_image_fill': {
      const node = requireScene(await getNode(args.nodeId));
      if (!('fills' in node)) throw new Error(`fills is not supported on ${node.type}`);
      const { image, normalized } = await createFigmaImage(args.base64, args.sourceMimeType);
      (node as GeometryMixin).fills = [{ type: 'IMAGE', imageHash: image.hash, scaleMode: args.scaleMode ?? 'FILL' }];
      figma.commitUndo();
      return { nodeId: node.id, imageHash: image.hash, normalized, scaleMode: args.scaleMode ?? 'FILL' };
    }
    case 'delete_node': {
      const node = requireScene(await getNode(args.nodeId));
      const deleted = { id: node.id, name: node.name };
      node.remove();
      figma.commitUndo();
      return { deleted };
    }
    case 'set_selection': {
      const nodes: SceneNode[] = [];
      for (const id of args.nodeIds) nodes.push(requireScene(await getNode(id)));
      const page = nodes.length ? pageOf(nodes[0]) : figma.currentPage;
      if (nodes.some(node => pageOf(node).id !== page.id)) throw new Error('All selected nodes must belong to the same page');
      await figma.setCurrentPageAsync(page);
      page.selection = nodes;
      if (args.focus && nodes.length) figma.viewport.scrollAndZoomIntoView(nodes);
      return { selected: nodes.map(n => n.id) };
    }
    case 'export_node': {
      const node = requireScene(await getNode(args.nodeId));
      if (!('exportAsync' in node)) throw new Error('Node does not support export');
      if (args.format === 'SVG') {
        const svg = await node.exportAsync({ format: 'SVG_STRING' });
        if (svg.length > 4 * 1024 * 1024) throw new Error('SVG exceeds 4 MiB; export a smaller node');
        return { svg };
      }
      const bounds = ('absoluteRenderBounds' in node ? node.absoluteRenderBounds : null) ?? node.absoluteBoundingBox;
      if (!bounds) throw new Error('Node has no visible bounds');
      const actualScale = Math.min(args.scale, 4096 / Math.max(bounds.width, bounds.height, 1));
      const bytes = await node.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: actualScale } });
      if (bytes.length > 8 * 1024 * 1024) throw new Error('PNG exceeds 8 MiB; lower scale or export a smaller node');
      return { data: figma.base64Encode(bytes), mimeType: 'image/png', scale: actualScale };
    }
    default: throw new Error(`Unknown command: ${command}`);
  }
}

figma.showUI(__html__, { width: 380, height: 480, themeColors: true });
let busy = false;
function publishDocument() {
  figma.ui.postMessage({ type: 'document', document: { name: figma.root.name, page: figma.currentPage.name,
    pluginVersion: '0.6.3', capabilities: getCapabilities() } });
}
figma.on('currentpagechange', publishDocument);
figma.ui.onmessage = async (message: any) => {
  if (message?.type === 'decode-image-result' && typeof message.id === 'string') {
    const pending = imageDecodeRequests.get(message.id);
    if (!pending) return;
    imageDecodeRequests.delete(message.id);
    clearTimeout(pending.timer);
    if (typeof message.error === 'string') pending.reject(new Error(message.error));
    else if (typeof message.base64 === 'string') pending.resolve(message.base64);
    else pending.reject(new Error('Image normalization returned no data'));
    return;
  }
  if (message?.type === 'init') {
    publishDocument();
    return;
  }
  if (message?.type === 'set-plan') {
    if (busy) { figma.ui.postMessage({ type: 'policy-error', error: 'Дождитесь завершения текущей операции.' }); return; }
    try { setDeclaredPlan(message.plan); publishDocument(); }
    catch (error) { figma.ui.postMessage({ type: 'policy-error', error: error instanceof Error ? error.message : String(error) }); }
    return;
  }
  if (message?.type !== 'command' || typeof message.id !== 'string') return;
  if (busy) {
    figma.ui.postMessage({ type: 'result', id: message.id, error: 'Plugin busy; wait for the running operation.' });
    return;
  }
  busy = true;
  try {
    const result = await execute(message.command, message.args ?? {});
    figma.ui.postMessage({ type: 'result', id: message.id, result });
  } catch (error) {
    figma.ui.postMessage({ type: 'result', id: message.id, error: error instanceof Error ? error.message : String(error) });
  } finally { busy = false; publishDocument(); }
};
