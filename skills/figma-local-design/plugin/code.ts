// Replaced by build.mjs using the release version in package.json.
declare const __PACKAGE_VERSION__: string;

import { designCommands, executeDesignCommand } from './design-system';
import { getCapabilities, setDeclaredPlan } from './capabilities';
import { extendedCommands, executeExtended } from './extended';
import { variableResolver } from './variables';
import { auditDesign } from './audit';
import { previewChanges, applyChanges } from './changes';
import { previewDesignFixes } from './design-fixes';
import { previewAuditFixes } from './audit-fixes';
import { createPresentation, initialWindowSize } from './presentation';
import { worldTransform, localTransform, verifyWorldTransform, placeNodes } from './node-placement';
import { readCommands, executeNodeRead, summarize, clean } from './node-reader';
import { jsonBytes, MAX_RESULT_BYTES, DEFAULT_READ_BYTES } from './response-size';
type Args = Record<string, any>;

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
async function applyProps(node: SceneNode, props: Args, beforeMutation: () => void = () => {}) {
  const target = node as any;
  const resolveVariable = variableResolver();
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
    const variable = variableId === null ? null : await resolveVariable(variableId as string);
    if (variableId !== null && (!variable || variable.resolvedType !== 'FLOAT')) throw new Error(`FLOAT variable not found for ${field}`);
    bindings.push({ field, variable });
  }
  const paints: Record<string, Paint[]> = {};
  if (props.fill !== undefined) paint(props.fill);
  if (props.stroke !== undefined) paint(props.stroke);
  if ((props.width !== undefined || props.height !== undefined) && !('resize' in node)) throw new Error(`Resize is not supported on ${node.type}`);
  for (const [key, field, raw] of [['fillVariableId', 'fills', 'fill'], ['strokeVariableId', 'strokes', 'stroke']]) {
    if (!props[key]) continue;
    if (!(field in node)) throw new Error(`${field} is not supported on ${node.type}`);
    if (props[raw] !== undefined) throw new Error(`Use ${key} or ${raw} in one call`);
    const variable = await resolveVariable(props[key]);
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
  beforeMutation();
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
  if (readCommands.has(command)) return executeNodeRead(command, args, { getNode, requireScene });
  if (extendedCommands.has(command)) return executeExtended(command, args, { getNode });
  if (designCommands.has(command)) return executeDesignCommand(command, args, { getNode, applyProps, createNode });
  switch (command) {
    case 'preview_design_fixes': return previewDesignFixes(args as any, getNode);
    case 'preview_changes': return previewChanges(args, getNode);
    case 'preview_audit_fixes': return previewAuditFixes(args as any, getNode);
    case 'apply_changes': return applyChanges(args, getNode);
    case 'audit_design': return auditDesign(await getNode(args.nodeId), args);
    case 'create_node': {
      const node = await createNode(args);
      figma.commitUndo();
      return summarize(node, 0, { left: 1 });
    }
    case 'update_node': {
      const node = requireScene(await getNode(args.nodeId));
      const target = node as any;
      const rollbackFields = ['name', 'x', 'y', 'width', 'height', 'rotation', 'opacity', 'visible', 'locked', 'fill', 'stroke', 'strokeWeight', 'cornerRadius'];
      const canRestore = ['RECTANGLE', 'ELLIPSE'].includes(node.type) && Object.keys(args.props).every(k => rollbackFields.includes(k)) &&
        !Object.keys(target.boundVariables ?? {}).length && !target.fillStyleId && !target.strokeStyleId &&
        !((node.parent as any)?.layoutMode && (node.parent as any).layoutMode !== 'NONE');
      const snapshot = canRestore ? { name: node.name, x: node.x, y: node.y, width: node.width, height: node.height,
        rotation: target.rotation, opacity: target.opacity, visible: node.visible, locked: node.locked,
        fills: target.fills, strokes: target.strokes, strokeWeight: target.strokeWeight, cornerRadius: target.cornerRadius } : null;
      let mutationStarted = false;
      try { await applyProps(node, args.props, () => { mutationStarted = true; }); }
      catch (error) {
        if (!mutationStarted) throw new Error(`${error instanceof Error ? error.message : String(error)}. No properties changed.`);
        if (snapshot) {
          try {
            target.resize(snapshot.width, snapshot.height);
            for (const [key, value] of Object.entries(snapshot)) if (!['width', 'height'].includes(key) && value !== undefined) target[key] = value;
          } catch { figma.commitUndo(); throw new Error('Update failed and rollback was incomplete. Inspect the node or use Figma Undo.'); }
          throw new Error(`${error instanceof Error ? error.message : String(error)}. Original shape properties restored.`);
        }
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
      for (const node of nodes) {
        let ancestor = node.parent;
        while (ancestor) {
          if (seen.has(ancestor.id)) throw new Error('Cannot move a node and its ancestor in the same operation');
          ancestor = ancestor.parent;
        }
      }
      const positions = args.preserveAbsolutePosition === false ? [] : nodes.map(node => ({ node, world: worldTransform(node) }));
      // Validate invertibility before any edit. Recompute after insertion for resizing ancestors.
      for (const item of positions) localTransform(parent, item.world);
      let insertIndex: number;
      try {
        insertIndex = placeNodes(parent, nodes, args.insertIndex);
        for (const item of positions) item.node.relativeTransform = localTransform(parent, item.world);
        for (const item of positions) verifyWorldTransform(item.node, item.world);
      } catch (error) {
        figma.commitUndo();
        throw new Error(`${error instanceof Error ? error.message : String(error)}. Some layers may have moved; inspect or use Figma Undo.`);
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
      let index: number;
      try { index = placeNodes(parent, nodes, args.index); }
      catch (error) {
        figma.commitUndo();
        throw new Error(`${error instanceof Error ? error.message : String(error)}. Some layers may have moved; inspect or use Figma Undo.`);
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
    default: throw new Error(`Unknown command: ${command}`);
  }
}

figma.showUI(__html__, { ...initialWindowSize, themeColors: true });
const presentation = createPresentation();
let busy = false;
function publishDocument() {
  figma.ui.postMessage({ type: 'document', document: { name: figma.root.name, page: figma.currentPage.name,
    pluginVersion: __PACKAGE_VERSION__, capabilities: getCapabilities() } });
}
figma.on('currentpagechange', publishDocument);
const findingTargets = new Set<string>();
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
    await presentation.initialize();
    return;
  }
  // Window controls are independent of document operations and never disconnect the bridge.
  if (message?.type === 'presentation-mode') { presentation.setMode(message.compact); return; }
  if (message?.type === 'presentation-move') { presentation.move(message.edge); return; }
  if (message?.type === 'focus-finding') {
    if (busy) { figma.ui.postMessage({ type: 'focus-result', error: 'Дождитесь завершения операции.' }); return; }
    if (!findingTargets.has(message.nodeId)) { figma.ui.postMessage({ type: 'focus-result', error: 'Повторите аудит: слоя нет в последнем отчёте.' }); return; }
    busy = true;
    try {
      const node = await getNode(message.nodeId);
      const page = pageOf(node);
      await figma.setCurrentPageAsync(page);
      if (node.type !== 'PAGE') page.selection = [requireScene(node)];
      figma.viewport.scrollAndZoomIntoView([node]);
      figma.ui.postMessage({ type: 'focus-result' });
    } catch { figma.ui.postMessage({ type: 'focus-result', error: 'Слой недоступен. Повторите аудит.' }); }
    finally { busy = false; }
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
    if (['audit_design', 'preview_audit_fixes', 'preview_design_fixes'].includes(message.command)) {
      findingTargets.clear();
      for (const finding of (result.findings ?? result.skipped ?? []).slice(0, 500))
        if (typeof finding.nodeId === 'string') findingTargets.add(finding.nodeId);
    }
    const response = { type: 'result', id: message.id, result };
    const responseLimit = ['get_node', 'get_selection'].includes(message.command)
      ? Math.min(message.args?.maxResponseBytes ?? DEFAULT_READ_BYTES, MAX_RESULT_BYTES) : MAX_RESULT_BYTES;
    if (jsonBytes(response) > responseLimit) throw new Error('RESPONSE_TOO_LARGE: Read a smaller range or fewer fields. A write may already have completed; inspect the file before retrying.');
    figma.ui.postMessage(response);
  } catch (error) {
    figma.ui.postMessage({ type: 'result', id: message.id, error: error instanceof Error ? error.message : String(error) });
  } finally { busy = false; publishDocument(); }
};
