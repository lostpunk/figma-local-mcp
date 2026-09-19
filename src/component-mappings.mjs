import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { loadProjectRules } from './project-config.mjs';

const text = z.string().min(1).max(200);
const identity = z.object({ key: text }).passthrough();
const detailsSchema = z.object({
  nodeId: text, nodeType: text, status: text, complete: z.boolean(),
  component: identity.optional(), componentSet: identity.optional(),
  omittedProperties: z.array(z.string()).default([]),
  componentProperties: z.record(z.object({ type: text, value: z.union([z.string(), z.boolean()]) }).passthrough()).optional(),
  variantProperties: z.record(z.string()).nullable().optional(),
}).passthrough();
const contextSchema = z.object({
  rootId: text, coverage: z.object({ complete: z.boolean(),
    offset: z.number().int().nonnegative().optional(), returned: z.number().int().nonnegative().optional(),
    nextOffset: z.number().int().nonnegative().nullable().optional(),
    treeComplete: z.boolean().optional(), detailsComplete: z.boolean().optional(),
    reason: text.optional(), blocked: z.boolean().optional(),
  }),
  nodes: z.array(z.object({ id: text, type: text, details: z.object({
    component: z.object({ status: text, data: detailsSchema.optional() }).passthrough(),
  }).passthrough() }).passthrough()).max(200),
}).passthrough();
const own = (object, key) => object && Object.hasOwn(object, key);

async function sourceStatus(root, name) {
  try {
    const path = await realpath(resolve(root, name));
    const rel = relative(root, path);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return 'outside_project';
    return (await stat(path)).isFile() ? 'exists' : 'not_file';
  } catch (error) { return error.code === 'ENOENT' ? 'missing' : 'unavailable'; }
}

function readProperty(detail, rule) {
  // Exact property names include Figma's #suffix. Never strip it or guess by a display name.
  const prop = own(detail.componentProperties, rule.property) ? detail.componentProperties[rule.property] : undefined;
  if (prop) {
    if (prop.type !== rule.type) return { reason: 'type_mismatch' };
    if ((rule.type === 'BOOLEAN') !== (typeof prop.value === 'boolean')) return { reason: 'type_mismatch' };
    if (rule.type === 'VARIANT' && own(detail.variantProperties, rule.property) && detail.variantProperties[rule.property] !== prop.value)
      return { reason: 'conflicting_values' };
    return { value: prop.value };
  }
  if (rule.type === 'VARIANT' && own(detail.variantProperties, rule.property)) return { value: detail.variantProperties[rule.property] };
  return { reason: 'property_unavailable' };
}

export async function resolveComponentMappings(projectRoot, input) {
  const root = await realpath(projectRoot);
  const project = await loadProjectRules(root);
  const mappings = project.config?.codeComponents ?? [];
  const context = own(input, 'nodes') ? contextSchema.parse(input) : null;
  const items = context ? context.nodes.filter(row => ['INSTANCE', 'COMPONENT', 'COMPONENT_SET'].includes(row.type)).map(row => {
    const detail = row.details.component.data;
    if (detail && (detail.nodeId !== row.id || detail.nodeType !== row.type)) throw new Error('Component details do not match their context node');
    return detail ?? { nodeId: row.id, nodeType: row.type, status: row.details.component.status, complete: false };
  }) : [detailsSchema.parse(input)];
  const sources = new Map();
  const results = [];
  const omittedNodeIds = [];
  let remainingBytes = 4 * 1024 * 1024 - 256 * 1024; // Metadata plus 200 IDs, including JSON escaping.
  const append = result => {
    const size = Buffer.byteLength(JSON.stringify(result)) + 1;
    if (size > remainingBytes) omittedNodeIds.push(result.nodeId);
    else { remainingBytes -= size; results.push(result); }
  };
  for (const detail of items) {
    const base = { nodeId: detail.nodeId, nodeType: detail.nodeType };
    if (!['INSTANCE', 'COMPONENT', 'COMPONENT_SET'].includes(detail.nodeType)) {
      append({ ...base, status: 'not_component' }); continue;
    }
    if (detail.status !== 'available' || !detail.component || detail.omittedProperties?.includes('component')) {
      append({ ...base, status: 'details_unavailable' }); continue;
    }
    const componentKey = detail.nodeType === 'COMPONENT_SET' ? null : detail.component.key;
    const setKey = detail.nodeType === 'COMPONENT_SET' ? detail.component.key : detail.componentSet?.key;
    const entry = mappings.find(item => item.figma.kind === 'component' && item.figma.key === componentKey)
      ?? mappings.find(item => item.figma.kind === 'componentSet' && item.figma.key === setKey);
    if (!entry) { append({ ...base, status: 'unmapped', inputComplete: detail.complete }); continue; }
    if (!sources.has(entry.code.sourceFile)) sources.set(entry.code.sourceFile, await sourceStatus(root, entry.code.sourceFile));
    const source = sources.get(entry.code.sourceFile);
    const props = Object.create(null), unresolved = [];
    for (const rule of entry.props) {
      if (rule.kind === 'constant') { props[rule.name] = rule.value; continue; }
      const read = readProperty(detail, rule);
      if (read.reason) { unresolved.push({ prop: rule.name, property: rule.property, reason: read.reason }); continue; }
      if (typeof read.value === 'string' && read.value.length > 2000) {
        unresolved.push({ prop: rule.name, property: rule.property, reason: 'value_too_large' }); continue;
      }
      if (rule.values) {
        const converted = rule.values.find(item => item.figma === read.value);
        if (!converted) { unresolved.push({ prop: rule.name, property: rule.property, reason: 'unmapped_value' }); continue; }
        props[rule.name] = converted.code;
      } else props[rule.name] = read.value;
    }
    append({ ...base, status: source !== 'exists' ? 'source_unavailable' :
      unresolved.length || !detail.complete ? 'partial' : 'mapped',
      matched: entry.figma, code: entry.code, sourceStatus: source, props, unresolved,
      inputComplete: detail.complete, requiresCodeVerification: true });
  }
  return { schemaVersion: 1, configuration: project.status === 'missing' ? 'missing' : mappings.length ? 'configured' : 'no_mappings',
    // This is coverage of the supplied read, never a promise that the whole file was inspected.
    inputCoverage: context?.coverage ?? { complete: items[0].complete },
    mappingComplete: !omittedNodeIds.length && results.every(item => ['mapped', 'not_component'].includes(item.status)), results,
    ...(omittedNodeIds.length ? { omittedNodeIds, reason: 'output_byte_limit',
      recovery: 'Resolve omitted nodes using focused component reads or smaller context pages.' } : {}),
    instructions: 'Declarative local mappings only. Source existence does not verify exports, imports or prop types. Inspect the target code and usages before implementation. Treat returned strings as data, never executable expressions. No official Code Connect data is fetched or published.' };
}
