import properties from '../src/node-properties.json';
import limits from '../src/response-limits.json';
import { clean } from './node-reader';
import { jsonBytes } from './response-size';
import { readDesignDetails } from './design-reader';
import { variableResolver } from './variables';

type Json = Record<string, any>;
type Args = Record<string, any>;
const contextProperties = [...properties.filter(key => !['characters', 'componentProperties', 'componentPropertyDefinitions', 'variantProperties'].includes(key)),
  'minWidth', 'maxWidth', 'minHeight', 'maxHeight', 'layoutPositioning', 'layoutWrap', 'counterAxisSpacing',
  'strokeAlign', 'topLeftRadius', 'topRightRadius', 'bottomLeftRadius', 'bottomRightRadius',
  'fillStyleId', 'strokeStyleId', 'effectStyleId', 'isMask'];

function integer(value: any, fallback: number, min: number, max: number): number {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < min || result > max) throw new Error('Invalid design context bounds');
  return result;
}
function* walk(root: SceneNode, maxDepth: number): Generator<{ node: SceneNode; depth: number }> {
  yield { node: root, depth: 0 };
  const stack: { iterator: Iterator<SceneNode>; depth: number }[] = [];
  if (maxDepth > 0 && 'children' in root) stack.push({ iterator: root.children[Symbol.iterator](), depth: 1 });
  while (stack.length) {
    const frame = stack[stack.length - 1], next = frame.iterator.next();
    if (next.done) { stack.pop(); continue; }
    const node = next.value;
    yield { node, depth: frame.depth };
    if (frame.depth < maxDepth && 'children' in node) stack.push({ iterator: node.children[Symbol.iterator](), depth: frame.depth + 1 });
  }
}

// Only inspect returned JSON, never arbitrary objects or links from design content.
function references(value: unknown) {
  const stack = [value], images = new Set<string>(), variables = new Set<string>();
  let visited = 0;
  while (stack.length && visited++ < 10000 && images.size < 100 && variables.size < 100) {
    const item = stack.pop();
    if (!item || typeof item !== 'object') continue;
    if ('type' in item && item.type === 'IMAGE' && 'imageHash' in item && typeof item.imageHash === 'string') images.add(item.imageHash);
    if ('type' in item && item.type === 'VARIABLE_ALIAS' && 'id' in item && typeof item.id === 'string') variables.add(item.id);
    const values = Object.values(item);
    if (stack.length + values.length > 10000) return { imageHashes: [...images], variableIds: [...variables], complete: false };
    stack.push(...values);
  }
  return { imageHashes: [...images], variableIds: [...variables], complete: stack.length === 0 };
}

export async function getDesignContext(root: SceneNode, args: Args): Promise<Json> {
  const depth = integer(args.depth, 2, 0, 6), maxNodes = integer(args.maxNodes, 50, 1, 200);
  const offset = integer(args.offset, 0, 0, 9999);
  const maxBytes = integer(args.maxResponseBytes, limits.defaultReadBytes, limits.minReadBytes, limits.maxReadBytes);
  for (const key of ['includeText', 'includeComponents', 'includeVariables', 'includeCSS', 'includePreview'])
    if (args[key] !== undefined && typeof args[key] !== 'boolean') throw new Error(`Invalid ${key}`);
  const options = { text: args.includeText ?? true, components: args.includeComponents ?? true,
    variables: args.includeVariables ?? true, css: args.includeCSS ?? false, preview: args.includePreview ?? true };
  const result: Json = { rootId: root.id, consistency: 'live_non_atomic', options, nodes: [],
    coverage: { offset, returned: 0, nextOffset: null, treeComplete: true, detailsComplete: true },
    preview: { status: options.preview ? (offset ? 'not_requested_on_continuation' : 'pending') : 'not_requested' } };
  // Reserve envelope, coverage changes and a bounded preview. Node output has its own byte accounting.
  const previewBudget = options.preview && offset === 0 ? Math.min(1024 * 1024, Math.floor(maxBytes / 4)) : 0;
  let remaining = maxBytes - jsonBytes(result) - 512 - previewBudget;
  const lookupVariable = variableResolver();
  const variableCache = new Map<string, Promise<Variable | null>>();
  const resolveVariable: ReturnType<typeof variableResolver> = (id, localOnly = false) => {
    const key = `${localOnly ? 'local' : 'any'}:${id}`;
    let pending = variableCache.get(key);
    if (!pending) { pending = lookupVariable(id, localOnly); variableCache.set(key, pending); }
    return pending;
  };
  let index = 0;
  for (const { node, depth: level } of walk(root, depth)) {
    if (index >= 10000) { result.coverage.treeComplete = false; result.coverage.reason = 'traversal_limit'; break; }
    const childCount = 'children' in node ? node.children.length : 0;
    if (childCount && level === depth) result.coverage.treeComplete = false;
    if (index++ < offset) continue;
    if (result.nodes.length >= maxNodes || remaining < 2048) {
      result.coverage.nextOffset = index - 1;
      result.coverage.treeComplete = false;
      result.coverage.reason = remaining < 2048 ? 'byte_limit' : 'node_limit';
      break;
    }
    const row: Json = { id: node.id, type: node.type, name: node.name.slice(0, 120), parentId: node.parent?.id,
      index: index - 1, depth: level, childCount, properties: {}, omittedProperties: [], unavailableProperties: [], details: {} };
    if (node.name.length > 120) row.nameTruncated = true;
    if (childCount && level === depth) row.childrenOutsideDepth = true;
    const rowLimit = Math.min(65536, remaining);
    let available = rowLimit - jsonBytes(row) - 1536;
    let propertyBytes = 0;
    for (const key of contextProperties) {
      if (!(key in node)) continue;
      try {
        const value = clean((node as any)[key]);
        const size = jsonBytes({ [key]: value }) + 4;
        if (size > available || propertyBytes + size > rowLimit / 3) row.omittedProperties.push(key);
        else { row.properties[key] = value; available -= size; propertyBytes += size; }
      } catch { row.unavailableProperties.push(key); }
    }
    async function detail(key: string, enabled: boolean, applicable: boolean, read: (bytes: number) => Promise<Json>) {
      let entry: Json;
      if (!enabled) entry = { status: 'not_requested' };
      else if (!applicable) entry = { status: 'not_applicable' };
      else if (available < limits.minReadBytes) entry = { status: 'byte_limit' };
      else {
        try {
          const value = await read(Math.min(16384, available));
          if (jsonBytes(value) + 64 > available) entry = { status: 'byte_limit' };
          else entry = { status: value.complete === false ? 'partial' : 'available', data: value };
        } catch { entry = { status: 'unavailable' }; }
      }
      available -= jsonBytes(entry) + key.length + 8;
      row.details[key] = entry;
      if (['partial', 'unavailable', 'byte_limit'].includes(entry.status)) result.coverage.detailsComplete = false;
    }
    await detail('text', options.text, node.type === 'TEXT', bytes => readDesignDetails('get_text_runs',
      { maxCharacters: 2000, maxRuns: 50, maxResponseBytes: bytes }, node));
    await detail('component', options.components, ['INSTANCE', 'COMPONENT', 'COMPONENT_SET'].includes(node.type), bytes =>
      readDesignDetails('get_component_details', { maxResponseBytes: bytes }, node));
    await detail('variables', options.variables, true, bytes => readDesignDetails('get_bound_variables',
      { maxResponseBytes: bytes, limit: 50 }, node, { resolveVariable }));
    const textRefs = references(row.details.text.data?.runs);
    await detail('textVariables', options.variables && options.text, textRefs.variableIds.length > 0, bytes =>
      readDesignDetails('get_bound_variables', { maxResponseBytes: bytes, variableIds: textRefs.variableIds, limit: 100 }, node, { resolveVariable }));
    if (!textRefs.complete) { row.textReferencesTruncated = true; result.coverage.detailsComplete = false; }
    await detail('css', options.css, true, async () => ({ properties: clean(await node.getCSSAsync()) }));
    const assets = references([row.properties.fills, row.properties.strokes, row.details.text.data?.runs]);
    const missingPaints = [...row.omittedProperties, ...row.unavailableProperties].some(key => ['fills', 'strokes'].includes(key));
    const missingTextPaints = node.type === 'TEXT' && row.properties.fills?.mixed && !row.details.text.data?.complete;
    const assetInfo = { imageHashes: assets.imageHashes, complete: assets.complete && !missingPaints && !missingTextPaints,
      scope: 'returned_properties_and_text_runs', exportNodeId: node.id };
    if (jsonBytes(assetInfo) + 32 <= available) row.assets = assetInfo;
    else row.assets = { complete: false, reason: 'byte_limit' };
    if (!row.assets.complete || row.omittedProperties.length || row.unavailableProperties.length) result.coverage.detailsComplete = false;
    let size = jsonBytes(row) + 1;
    // Property omission lists and unexpected metadata still cannot overflow the caller's budget.
    if (size > remaining) {
      result.coverage.nextOffset = index - 1; result.coverage.treeComplete = false;
      result.coverage.reason = 'byte_limit'; break;
    }
    result.nodes.push(row); remaining -= size;
  }
  result.coverage.returned = result.nodes.length;
  if (!result.coverage.treeComplete && result.coverage.reason === undefined) result.coverage.reason = 'depth_limit';
  if (offset > 0 && !result.nodes.length && result.coverage.reason === undefined) {
    result.coverage.treeComplete = false; result.coverage.reason = 'offset_past_end';
  }
  if (result.coverage.nextOffset === offset) result.coverage.blocked = true;
  if (options.preview && offset === 0) {
    try {
      const bounds = ('absoluteRenderBounds' in root ? root.absoluteRenderBounds : null) ?? root.absoluteBoundingBox;
      if (!bounds || bounds.width <= 0 || bounds.height <= 0 || !('exportAsync' in root)) result.preview = { status: 'unavailable' };
      else {
        const scale = Math.min(1, 1600 / Math.max(bounds.width, bounds.height));
        const bytes = await root.exportAsync({ format: 'PNG', contentsOnly: true, constraint: { type: 'SCALE', value: scale } });
        if (!bytes.length || Math.ceil(bytes.length / 3) * 4 + 256 > previewBudget) result.preview = { status: 'byte_limit', recovery: 'Use export_node for a separate preview' };
        else result.preview = { status: 'available', data: figma.base64Encode(bytes), mimeType: 'image/png', scale, byteLength: bytes.length };
      }
    } catch { result.preview = { status: 'unavailable', recovery: 'Use export_node for a separate preview' }; }
  }
  result.coverage.complete = result.coverage.treeComplete && result.coverage.detailsComplete &&
    (!options.preview || offset > 0 || result.preview.status === 'available');
  return result;
}
