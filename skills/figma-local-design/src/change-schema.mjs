import { z } from 'zod';

const number = z.number().finite();
const id = z.string().min(1).max(200);
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use #RRGGBB').nullable();
const properties = z.object({
  name: z.string().max(500).optional(),
  x: number.min(-1000000).max(1000000).optional(),
  y: number.min(-1000000).max(1000000).optional(),
  width: number.positive().max(100000).optional(),
  height: number.positive().max(100000).optional(),
  itemSpacing: number.min(0).max(1000).optional(),
  paddingTop: number.min(0).max(1000).optional(), paddingBottom: number.min(0).max(1000).optional(),
  paddingLeft: number.min(0).max(1000).optional(), paddingRight: number.min(0).max(1000).optional(),
  opacity: number.min(0).max(1).optional(),
  visible: z.boolean().optional(), locked: z.boolean().optional(),
  fill: color.optional(), stroke: color.optional(),
  strokeWeight: number.min(0).max(1000).optional(),
  cornerRadius: number.min(0).max(100000).optional(),
}).strict().refine(value => Object.keys(value).length > 0, 'Provide at least one property');

export const previewChangesSchema = {
  changes: z.array(z.object({ nodeId: id, props: properties }).strict()).min(1).max(50)
    .superRefine((changes, ctx) => {
      if (new Set(changes.map(change => change.nodeId)).size !== changes.length)
        ctx.addIssue({ code: 'custom', message: 'Each node must occur only once' });
      if (changes.reduce((sum, change) => sum + Object.keys(change.props).length, 0) > 200)
        ctx.addIssue({ code: 'custom', message: 'At most 200 properties per preview' });
    }),
};
export const applyChangesSchema = {
  planId: id,
  changeIds: z.array(id).min(1).max(200)
    .refine(ids => new Set(ids).size === ids.length, 'Change IDs must be unique'),
};
