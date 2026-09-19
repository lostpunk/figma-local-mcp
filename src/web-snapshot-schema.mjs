import { z } from 'zod';
const finite = z.number().finite();
const coord = finite.min(-100000).max(100000);
const size = finite.positive().max(20000);
const ref = z.string().regex(/^n\d{1,6}$/);
const color = z.object({ r: finite.min(0).max(1), g: finite.min(0).max(1), b: finite.min(0).max(1), a: finite.min(0).max(1) }).strict();
const label = z.string().max(200);
const font = z.object({ family: label, weight: z.number().int().min(100).max(900), italic: z.boolean(),
  size: finite.positive().max(1000), lineHeight: finite.positive().max(2000).nullable(),
  letterSpacing: finite.min(-100).max(100), align: z.enum(['LEFT', 'CENTER', 'RIGHT', 'JUSTIFIED']), color }).strict();
const layout = z.object({ direction: z.enum(['HORIZONTAL', 'VERTICAL']), gap: finite.min(0).max(10000),
  padding: z.array(finite.min(0).max(10000)).length(4),
  justify: z.enum(['MIN', 'CENTER', 'MAX', 'SPACE_BETWEEN']), align: z.enum(['MIN', 'CENTER', 'MAX']) }).strict();
export const webSnapshotSchema = z.object({
  format: z.literal('figma-local-web-v1'),
  viewport: z.object({ width: size, height: size, scrollX: coord, scrollY: coord }).strict(),
  coverage: z.object({ complete: z.boolean(), visited: z.number().int().min(0).max(10000), reason: label.optional() }).strict(),
  warnings: z.array(z.object({ ref: ref.optional(), code: label }).strict()).max(500),
  nodes: z.array(z.object({ ref, parentRef: ref.optional(), kind: z.enum(['FRAME', 'TEXT', 'IMAGE']), name: label,
    x: coord, y: coord, width: size, height: size,
    opacity: finite.min(0).max(1), fill: color.nullable(), border: z.object({ color, width: finite.min(0).max(1000) }).strict().nullable(),
    radii: z.array(finite.min(0).max(10000)).length(4),
    clipsContent: z.boolean(), text: z.string().max(2000).optional(), font: font.optional(),
    textLayout: z.enum(['SINGLE_LINE', 'WRAPPED']).optional(),
    imageRef: ref.optional(), imageFit: z.enum(['FILL', 'FIT']).optional(), layout: layout.optional(),
  }).strict()).min(1).max(200),
  images: z.array(z.object({ ref, png: z.string().min(1).max(2 * 1024 * 1024).regex(/^[A-Za-z0-9+/]+={0,2}$/) }).strict()).max(40),
}).strict().superRefine((s, ctx) => {
  const issue = message => ctx.addIssue({ code: 'custom', message });
  const nodes = new Map(), images = new Set();
  for (const image of s.images) { if (images.has(image.ref)) issue('Duplicate image ref'); images.add(image.ref); }
  s.nodes.forEach((n, i) => {
    if (nodes.has(n.ref)) issue('Duplicate node ref');
    if (i === 0 ? n.parentRef || n.kind !== 'FRAME' || n.x !== 0 || n.y !== 0 : !n.parentRef || nodes.get(n.parentRef)?.kind !== 'FRAME') issue('Expected one root frame and parents before children');
    if (n.kind === 'TEXT' ? n.text === undefined || !n.font : n.text !== undefined || n.font !== undefined) issue('Text content and font belong to TEXT nodes only');
    if (n.textLayout && n.kind !== 'TEXT') issue('Text layout belongs to TEXT nodes only');
    if (n.textLayout === 'SINGLE_LINE' && /[\r\n]/.test(n.text ?? '')) issue('Single-line text cannot contain line breaks');
    if (n.layout && n.kind !== 'FRAME') issue('Auto Layout requires FRAME');
    if ((n.imageRef || n.imageFit) && n.kind !== 'IMAGE') issue('Image fields require IMAGE');
    if (n.imageRef && !images.has(n.imageRef)) issue('Missing image data');
    nodes.set(n.ref, n);
  });
  // UTF-8 upper bound without relying on Buffer, so validation also runs in Figma's sandbox.
  const raw = JSON.stringify(s);
  let bytes = 0;
  for (const ch of raw) { const cp = ch.codePointAt(0); bytes += cp < 128 ? 1 : cp < 2048 ? 2 : cp < 65536 ? 3 : 4; }
  if (bytes > 4 * 1024 * 1024) issue('Snapshot exceeds 4 MiB; capture a smaller section');
});
export const importWebSnapshotSchema = {
  snapshot: webSnapshotSchema.optional(), filePath: z.string().min(1).max(4096).optional(), parentId: z.string().min(1).max(200).optional(),
  x: coord.default(0), y: coord.default(0), dryRun: z.boolean().default(true), revision: z.string().max(100).optional(),
};
