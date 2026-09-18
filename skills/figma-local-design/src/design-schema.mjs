import { z } from 'zod';

const name = z.string().trim().min(1).max(100);
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const scalar = z.number().finite().min(0).max(1000);
const unique = list => new Set(list.map(x => x.name)).size === list.length;
export const guideSchema = {
  pageId: z.string().min(1).max(200).optional(),
  name: name.default('Foundation'),
  colors: z.array(z.object({ name, value: color }).strict()).min(1).max(40)
    .refine(unique, 'Color names must be unique').default([
      { name: 'background', value: '#F8FAFC' }, { name: 'surface', value: '#FFFFFF' },
      { name: 'text/primary', value: '#0F172A' }, { name: 'text/muted', value: '#475569' },
      { name: 'brand/primary', value: '#2563EB' }, { name: 'brand/on-primary', value: '#FFFFFF' },
      { name: 'border', value: '#CBD5E1' }, { name: 'success', value: '#15803D' },
      { name: 'warning', value: '#A16207' }, { name: 'danger', value: '#B91C1C' },
    ]),
  typography: z.array(z.object({
    name, fontFamily: name.default('Inter'), fontStyle: name.default('Regular'),
    fontSize: z.number().finite().positive().max(120),
    lineHeight: z.number().finite().positive().max(240).optional(),
  }).strict()).min(1).max(20).refine(unique, 'Typography names must be unique').default([
    { name: 'Heading/H1', fontFamily: 'Inter', fontStyle: 'Bold', fontSize: 40, lineHeight: 48 },
    { name: 'Heading/H2', fontFamily: 'Inter', fontStyle: 'Bold', fontSize: 28, lineHeight: 36 },
    { name: 'Body/Regular', fontFamily: 'Inter', fontStyle: 'Regular', fontSize: 16, lineHeight: 24 },
    { name: 'Label/Medium', fontFamily: 'Inter', fontStyle: 'Medium', fontSize: 14, lineHeight: 20 },
    { name: 'Caption', fontFamily: 'Inter', fontStyle: 'Regular', fontSize: 12, lineHeight: 16 },
  ]),
  spacing: z.array(z.object({ name, value: scalar }).strict()).max(30)
    .refine(unique, 'Spacing names must be unique').default([4, 8, 12, 16, 24, 32, 48, 64].map(value => ({ name: String(value), value }))),
  radii: z.array(z.object({ name, value: scalar }).strict()).max(20)
    .refine(unique, 'Radius names must be unique').default([0, 4, 8, 12, 16, 24].map(value => ({ name: String(value), value }))),
};

// A patch has no creation defaults: omitted groups must remain untouched.
export const syncGuideSchema = {
  collectionId: z.string().min(1).max(200),
  dryRun: z.boolean().default(true),
  colors: guideSchema.colors.removeDefault().optional(),
  typography: z.array(z.object({ name, fontFamily: name, fontStyle: name,
    fontSize: z.number().finite().positive().max(120),
    lineHeight: z.number().finite().positive().max(240).optional(),
  }).strict()).min(1).max(20).refine(unique, 'Typography names must be unique').optional(),
  spacing: guideSchema.spacing.removeDefault().optional(),
  radii: guideSchema.radii.removeDefault().optional(),
};

export function sceneSchema(props) {
  return z.array(z.object({
    ref: name, parentRef: name.optional(),
    type: z.enum(['FRAME', 'RECTANGLE', 'ELLIPSE', 'TEXT', 'COMPONENT']),
    props: props.default({}),
  }).strict()).min(1).max(100).superRefine((nodes, context) => {
    const refs = new Map();
    nodes.forEach((node, index) => {
      if (refs.has(node.ref)) context.addIssue({ code: 'custom', path: [index, 'ref'], message: 'Duplicate ref' });
      if (node.parentRef && !['FRAME', 'COMPONENT'].includes(refs.get(node.parentRef))) {
        context.addIssue({ code: 'custom', path: [index, 'parentRef'], message: 'parentRef must name an earlier FRAME or COMPONENT' });
      }
      refs.set(node.ref, node.type);
    });
  });
}
