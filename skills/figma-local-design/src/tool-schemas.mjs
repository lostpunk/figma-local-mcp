import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

export const TOOL_SCHEMA_DIALECT = 'https://json-schema.org/draft/2020-12/schema';

// The Zod 3 converter emits Draft-07. Our tool schemas use its subset that
// has identical semantics in 2020-12. Reject incompatible additions instead
// of silently relabelling tuples or changing their validation semantics.
export function toolInputSchema(shape) {
  // Match the SDK's empty-object fallback without tightening accepted input.
  if (Object.keys(shape).length === 0) return { type: 'object', properties: {}, $schema: TOOL_SCHEMA_DIALECT };
  const schema = zodToJsonSchema(z.object(shape), { strictUnions: true, pipeStrategy: 'input' });
  function check(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node.items) || 'additionalItems' in node || 'dependencies' in node || '$recursiveRef' in node || '$recursiveAnchor' in node) {
      throw new Error('Tool schema uses a keyword requiring explicit Draft 2020-12 conversion');
    }
    // Traverse schema positions only: user property names and defaults may
    // themselves contain words such as "items" or "dependencies".
    for (const key of ['properties', 'patternProperties', 'definitions', '$defs', 'dependentSchemas']) {
      for (const child of Object.values(node[key] ?? {})) check(child);
    }
    for (const key of ['items', 'additionalProperties', 'propertyNames', 'contains', 'not', 'if', 'then', 'else']) check(node[key]);
    for (const key of ['allOf', 'anyOf', 'oneOf', 'prefixItems']) for (const child of node[key] ?? []) check(child);
  }
  check(schema);
  return { ...schema, $schema: TOOL_SCHEMA_DIALECT };
}

// Keep SDK argument validation and call dispatch. Only replace discovery,
// because this SDK version hardcodes Draft-07 for Zod 3 tools/list schemas.
// Tools in this server are registered once, before connect (no dynamic tools).
export function createToolRegistry(server) {
  const tools = [];
  return {
    register(name, config, handler) {
      const inputSchema = toolInputSchema(config.inputSchema);
      const tool = server.registerTool(name, config, handler);
      tools.push({ name, title: tool.title, description: tool.description, inputSchema,
        annotations: tool.annotations, execution: tool.execution, _meta: tool._meta });
    },
    installListHandler() {
      server.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
    },
  };
}
