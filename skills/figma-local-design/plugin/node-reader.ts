import properties from '../src/node-properties.json';
import { jsonBytes, DEFAULT_READ_BYTES } from './response-size';
import { getCapabilities } from './capabilities';
type Args = Record<string, any>;
type Json = Record<string, any>;
type Helpers = { getNode(id: string): Promise<BaseNode>; requireScene(node: BaseNode): SceneNode };
export const readCommands = new Set(['get_document', 'get_selection', 'get_node', 'find_nodes', 'export_node']);

export function clean(value: any): any {
  if (value === figma.mixed) return { mixed: true };
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value, (_key, v) => typeof v === 'symbol' ? { mixed: true } : v));
}
type ReadBudget = { left: number; bytes?: number; fields?: string[] };
export function summarize(node: BaseNode, depth: number, budget: ReadBudget, childOffset = 0): Json {
  budget.left--;
  budget.bytes ??= DEFAULT_READ_BYTES;
  const result: Json = { id: node.id, type: node.type, name: node.name.slice(0, 500), parentId: node.parent?.id };
  if (node.name.length > 500) result.nameTruncated = true;
  // Reserve metadata, pagination and omitted-property names before admitting property payloads.
  budget.bytes -= jsonBytes(result) + 1024;
  const source = node as any;
  const omitted: string[] = [];
  for (const key of budget.fields ?? properties) {
    if (key === 'componentPropertyDefinitions' && node.type === 'COMPONENT' && node.parent?.type === 'COMPONENT_SET') continue;
    if (!(key in node)) continue;
    let value = source[key];
    if (key === 'characters' && typeof value === 'string' && value.length > 10000) {
      result.characterCount = value.length;
      result.charactersTruncated = true;
      value = value.slice(0, 10000);
    }
    value = clean(value);
    const size = jsonBytes({ [key]: value });
    if (size > budget.bytes) { omitted.push(key); continue; }
    result[key] = value;
    budget.bytes -= size;
  }
  if (omitted.length) { result.omittedProperties = omitted; result.responseTruncated = true; }
  if ('children' in node) {
    const children = (node as ChildrenMixin).children;
    result.childCount = children.length;
    result.childOffset = Math.min(childOffset, children.length);
    result.children = [];
    let next = result.childOffset;
    if (depth > 0) {
      while (next < children.length && budget.left > 0 && budget.bytes >= 2048) {
        result.children.push(summarize(children[next++], depth - 1, budget));
      }
    }
    result.childrenTruncated = next < children.length;
    result.nextChildOffset = next < children.length ? next : null;
  }
  return result;
}

export async function executeNodeRead(command: string, args: Args, { getNode, requireScene }: Helpers): Promise<any> {
  if (args.fields?.some((field: string) => !properties.includes(field))) throw new Error('Unknown node field');
  const budget: ReadBudget = { left: args.maxNodes ?? 200, bytes: (args.maxResponseBytes ?? DEFAULT_READ_BYTES) - 256, fields: args.fields };
  switch (command) {
    case 'get_document':
      return { name: figma.root.name, currentPageId: figma.currentPage.id,
        pages: figma.root.children.map(p => ({ id: p.id, name: p.name })), capabilities: getCapabilities() };
    case 'get_selection': {
      const nodes = [];
      const offset = Math.min(args.selectionOffset ?? 0, figma.currentPage.selection.length);
      for (const node of figma.currentPage.selection.slice(offset)) {
        if (budget.left <= 0 || budget.bytes! < 2048) break;
        nodes.push(summarize(node, args.depth, budget));
      }
      return { nodes, selectionCount: figma.currentPage.selection.length,
        selectionOffset: offset,
        nextSelectionOffset: offset + nodes.length < figma.currentPage.selection.length ? offset + nodes.length : null,
        selectionTruncated: offset + nodes.length < figma.currentPage.selection.length };
    }
    case 'get_node': return summarize(await getNode(args.nodeId), args.depth, budget, args.childOffset ?? 0);
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
    default: throw new Error(`Unknown read operation: ${command}`);
  }
}
