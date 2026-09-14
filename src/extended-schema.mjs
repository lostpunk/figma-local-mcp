import { z } from 'zod';
const id = z.string().min(1).max(200);
const position = z.number().finite();
const size = z.number().finite().positive().max(100000);
const name = z.string().trim().min(1).max(200);
const filePath = z.string().min(1).max(4096).optional();
export const imageSchema = {
  filePath, dataBase64: z.string().min(1).max(11184812).optional(),
  nodeId: id.optional(), parentId: id.optional(), name: name.optional(),
  x: position.optional(), y: position.optional(), width: size.optional(), height: size.optional(),
  scaleMode: z.enum(['FILL', 'FIT']).default('FILL'),
};
export const svgSchema = {
  filePath, svg: z.string().min(1).max(1048576).optional(), parentId: id.optional(),
  name: name.optional(), x: position.optional(), y: position.optional(), width: size.optional(),
};
const variantLabel = z.string().trim().min(1).max(80).refine(v => !/[,=\r\n]/.test(v), 'Variant labels cannot contain commas, equals signs or newlines');
export const componentSetSchema = {
  name, parentId: id.optional(), x: position.default(0), y: position.default(0),
  spacing: z.number().finite().min(0).max(1000).default(24),
  variants: z.array(z.object({ componentId: id, properties: z.record(variantLabel, variantLabel) }).strict()).min(2).max(50)
    .superRefine((variants, ctx) => {
      const keys = Object.keys(variants[0].properties).sort();
      if (!keys.length || keys.length > 8) ctx.addIssue({ code: 'custom', message: 'Use 1–8 variant properties' });
      const combos = new Set();
      for (const v of variants) {
        if (JSON.stringify(Object.keys(v.properties).sort()) !== JSON.stringify(keys)) ctx.addIssue({ code: 'custom', message: 'All variants must use the same property names' });
        const combo = JSON.stringify(keys.map(k => v.properties[k]));
        if (combos.has(combo)) ctx.addIssue({ code: 'custom', message: 'Duplicate variant combination' });
        combos.add(combo);
      }
    }),
};
export const instancePropertiesSchema = {
  nodeId: id, properties: z.record(id, z.union([z.string().max(10000), z.boolean()]))
    .refine(v => Object.keys(v).length > 0 && Object.keys(v).length <= 30, 'Set 1–30 properties'),
};
export const prototypeSchema = {
  nodeId: id, destinationId: id.optional(),
  action: z.enum(['NAVIGATE', 'OVERLAY', 'CHANGE_TO', 'BACK', 'CLOSE']).default('NAVIGATE'),
  trigger: z.enum(['ON_CLICK', 'ON_HOVER', 'ON_PRESS']).default('ON_CLICK'),
  transition: z.enum(['INSTANT', 'DISSOLVE', 'SMART_ANIMATE']).default('INSTANT'),
  durationMs: z.number().finite().min(1).max(10000).default(300),
  replaceExisting: z.boolean().default(false),
};
export const prototypeStartSchema = { frameId: id, name };
