import textProperties from '../src/text-properties.json';
import limits from '../src/response-limits.json';
import { jsonBytes } from './response-size';
import { variableResolver } from './variables';

type Json = Record<string, any>;
type Args = Record<string, any>;
export const designReadCommands = new Set(['get_text_runs', 'get_component_details', 'get_bound_variables']);

// Each read reserves space for the transport envelope and pagination/status metadata.
function budget(args: Args) {
  const limit = args.maxResponseBytes ?? limits.defaultReadBytes;
  if (!Number.isInteger(limit) || limit < limits.minReadBytes || limit > limits.maxReadBytes)
    throw new Error('Invalid maxResponseBytes');
  let remaining = limit - 2048;
  return (value: unknown) => {
    const size = jsonBytes(value) + 32;
    if (size > remaining) return false;
    remaining -= size;
    return true;
  };
}
function integer(value: any, fallback: number, min: number, max: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < min || result > max) throw new Error(`Invalid ${name}`);
  return result;
}
function splitsSurrogate(text: string, index: number): boolean {
  return index > 0 && index < text.length &&
    text.charCodeAt(index - 1) >= 0xd800 && text.charCodeAt(index - 1) <= 0xdbff &&
    text.charCodeAt(index) >= 0xdc00 && text.charCodeAt(index) <= 0xdfff;
}
function identity(node: ComponentNode | ComponentSetNode): Json {
  return { id: node.id, key: node.key, name: node.name.slice(0, 500),
    nameTruncated: node.name.length > 500, remote: node.remote };
}

export async function readDesignDetails(command: string, args: Args, node: SceneNode,
  dependencies: { resolveVariable?: ReturnType<typeof variableResolver> } = {}): Promise<Json> {
  const admit = budget(args);
  if (command === 'get_text_runs') {
    if (node.type !== 'TEXT') throw new Error('get_text_runs requires a TEXT node');
    const start = integer(args.start, 0, 0, Number.MAX_SAFE_INTEGER, 'start');
    const count = integer(args.maxCharacters, 4000, 2, 10000, 'maxCharacters');
    const maxRuns = integer(args.maxRuns, 100, 1, 500, 'maxRuns');
    const fields = args.fields ?? textProperties;
    if (!Array.isArray(fields) || fields.length > textProperties.length || fields.some(field => !textProperties.includes(field)))
      throw new Error('Unknown text field');
    const characters = node.characters;
    if (start > characters.length) throw new Error('Text start exceeds current length; restart the read after text edits');
    if (splitsSurrogate(characters, start)) throw new Error('Text start splits a UTF-16 surrogate pair; use nextStart');
    let end = Math.min(start + count, characters.length);
    if (splitsSurrogate(characters, end)) end--;
    const runs: Json[] = [];
    let next = start;
    let reason: string | undefined;
    const segments = end > start ? node.getStyledTextSegments(fields as (keyof Omit<StyledTextSegment, 'characters' | 'start' | 'end'>)[], start, end) : [];
    for (const segment of segments) {
      if (runs.length >= maxRuns) { reason = 'run_limit'; break; }
      if (!admit(segment)) { reason = 'byte_limit'; break; }
      runs.push(segment);
      next = segment.end;
    }
    return { nodeId: node.id, indexUnit: 'UTF-16', characterCount: characters.length, start,
      fields, runs, nextStart: next < characters.length ? next : null,
      complete: next === characters.length, reason: reason ?? (next < characters.length ? 'character_limit' : undefined),
      ...(reason === 'byte_limit' && next === start ? { blocked: true,
        recovery: 'Reduce maxCharacters or fields, or increase maxResponseBytes; do not repeat the same request.' } : {}) };
  }
  if (command === 'get_component_details') {
    const result: Json = { nodeId: node.id, nodeType: node.type, omittedProperties: [] };
    const add = (key: string, value: unknown) => {
      if (value === undefined) return;
      if (admit({ [key]: value })) result[key] = value;
      else result.omittedProperties.push(key);
    };
    let component: ComponentNode | ComponentSetNode | null;
    if (node.type === 'INSTANCE') {
      add('componentProperties', node.componentProperties);
      add('variantProperties', node.variantProperties);
      try { component = await node.getMainComponentAsync(); }
      catch { return { ...result, status: 'unavailable', complete: false }; }
      if (!component) return { ...result, status: 'main_component_missing', complete: false };
    } else if (node.type === 'COMPONENT' || node.type === 'COMPONENT_SET') component = node;
    else return { ...result, status: 'not_component', complete: true };
    add('component', identity(component));
    const owner = component.parent?.type === 'COMPONENT_SET' ? component.parent : component;
    if (owner !== component) add('componentSet', identity(owner));
    add('definitionOwnerId', owner.id);
    // A variant's property definitions belong to its set; reading the variant getter can throw.
    add('componentPropertyDefinitions', owner.componentPropertyDefinitions);
    if (node.type !== 'INSTANCE') add('variantProperties', component.type === 'COMPONENT' ? component.variantProperties : undefined);
    return { ...result, status: 'available', complete: result.omittedProperties.length === 0 };
  }
  if (command === 'get_bound_variables') {
    const offset = integer(args.offset, 0, 0, 1000000, 'offset');
    const limit = integer(args.limit, 50, 1, 100, 'limit');
    let ids: string[];
    let scanTruncated = false;
    if (args.variableIds !== undefined) {
      if (!Array.isArray(args.variableIds) || args.variableIds.length > 100 ||
          args.variableIds.some((id: unknown) => typeof id !== 'string' || !id.length || id.length > 200))
        throw new Error('Invalid variableIds');
      ids = [...new Set<string>(args.variableIds)];
    } else {
      const found = new Set<string>();
      const stack: unknown[] = [node.boundVariables];
      for (const field of ['fills', 'strokes', 'effects', 'layoutGrids'] as const) {
        if (field in node) stack.push((node as any)[field]);
      }
      let visited = 0;
      while (stack.length && visited++ < 20000 && found.size < 1000) {
        const value = stack.pop();
        if (!value || typeof value !== 'object') continue;
        if ('type' in value && value.type === 'VARIABLE_ALIAS' && 'id' in value && typeof value.id === 'string') found.add(value.id);
        else {
          const values = Object.values(value);
          // Bound traversal memory as well as output size.
          if (values.length + stack.length > 20000) { scanTruncated = true; break; }
          stack.push(...values);
        }
      }
      scanTruncated ||= stack.length > 0;
      ids = [...found].sort();
    }
    const variables: Json[] = [];
    const resolveVariable = dependencies.resolveVariable ?? variableResolver();
    let next = Math.min(offset, ids.length);
    let byteLimited = false;
    for (; next < ids.length && variables.length < limit; next++) {
      const id = ids[next];
      let entry: Json;
      try {
        const variable = await resolveVariable(id);
        if (!variable) entry = { id, status: 'not_found' };
        else {
          const modeId = node.resolvedVariableModes[variable.variableCollectionId] ?? null;
          entry = { id, name: variable.name, key: variable.key, remote: variable.remote,
            collectionId: variable.variableCollectionId, resolvedType: variable.resolvedType,
            modeId, modeValue: modeId ? variable.valuesByMode[modeId] : undefined, codeSyntax: variable.codeSyntax };
          try { entry.resolved = variable.resolveForConsumer(node); entry.status = 'resolved'; }
          catch { entry.status = 'unresolved'; }
        }
      } catch { entry = { id, status: 'unavailable' }; }
      if (!admit(entry)) { byteLimited = true; break; }
      variables.push(entry);
    }
    return { nodeId: node.id, scope: args.variableIds ? 'requested_ids_for_consumer' : 'node_properties_only',
      variables, total: ids.length, offset: Math.min(offset, ids.length), nextOffset: next < ids.length ? next : null,
      scanTruncated, complete: !scanTruncated && next === ids.length && variables.every(item => item.status === 'resolved'),
      ...(byteLimited ? { reason: 'byte_limit', blocked: variables.length === 0,
        recovery: 'Increase maxResponseBytes; read a specific variable using variableIds.' } : {}) };
  }
  throw new Error('Unknown design read operation');
}
