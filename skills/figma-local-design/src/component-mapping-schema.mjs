import { z } from 'zod';

const text = z.string().min(1).max(200);
const name = text.regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/)
  .refine(value => !['__proto__', 'constructor', 'prototype'].includes(value), 'Reserved name');
export const projectRelativeFile = z.string().min(1).max(500).refine(value =>
  !/^[\\/]/.test(value) && !/[:\\\u0000-\u001f\u007f]/.test(value)
  && !value.split('/').some(part => ['..', '', '.'].includes(part)), 'Use a project-relative file path without ..');
const literal = z.union([z.string().max(2000), z.boolean(), z.number().finite(), z.null()]);
const property = z.object({
  kind: z.literal('property'), name,
  property: text, type: z.enum(['TEXT', 'BOOLEAN', 'VARIANT', 'INSTANCE_SWAP']),
  values: z.array(z.object({ figma: z.union([z.string().max(2000), z.boolean()]), code: literal }).strict()).min(1).max(100).optional(),
}).strict().superRefine((value, ctx) => {
  if (['VARIANT', 'INSTANCE_SWAP'].includes(value.type) && !value.values)
    ctx.addIssue({ code: 'custom', path: ['values'], message: 'Variants and instance swaps require an explicit value map' });
  const seen = new Set();
  for (const item of value.values ?? []) {
    if ((value.type === 'BOOLEAN') !== (typeof item.figma === 'boolean'))
      ctx.addIssue({ code: 'custom', path: ['values'], message: 'Figma value type must match the declared property type' });
    const key = JSON.stringify(item.figma);
    if (seen.has(key)) ctx.addIssue({ code: 'custom', path: ['values'], message: 'Duplicate Figma value' });
    seen.add(key);
  }
});
export const codeComponentsSchema = z.array(z.object({
  figma: z.object({ kind: z.enum(['component', 'componentSet']), key: text }).strict(),
  code: z.object({ sourceFile: projectRelativeFile,
    importFrom: z.string().min(1).max(500).regex(/^(?:\.{1,2}\/)?[@A-Za-z0-9_][@A-Za-z0-9_./-]*$/),
    exportName: name, exportKind: z.enum(['named', 'default']).default('named'),
    framework: text.optional(),
  }).strict(),
  props: z.array(z.union([z.object({ kind: z.literal('constant'), name, value: literal }).strict(), property])).max(50).default([]),
}).strict()).max(100).superRefine((entries, ctx) => {
  const keys = new Set();
  entries.forEach((entry, index) => {
    const key = `${entry.figma.kind}:${entry.figma.key}`;
    if (keys.has(key)) ctx.addIssue({ code: 'custom', path: [index, 'figma'], message: 'Duplicate component mapping' });
    keys.add(key);
    const props = entry.props.map(prop => prop.name);
    if (new Set(props).size !== props.length)
      ctx.addIssue({ code: 'custom', path: [index, 'props'], message: 'Duplicate target prop' });
  });
});
