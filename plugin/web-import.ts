import { webSnapshotSchema } from '../src/web-snapshot-schema.mjs';
import { resourceRevision } from './resource-revision';

type Color = { r: number; g: number; b: number; a: number };
type Row = { ref: string; parentRef?: string; kind: 'FRAME' | 'TEXT' | 'IMAGE'; name: string;
  x: number; y: number; width: number; height: number; opacity: number; fill: Color | null;
  border: { color: Color; width: number } | null; radii: [number, number, number, number]; clipsContent: boolean;
  text?: string; textLayout?: 'SINGLE_LINE' | 'WRAPPED'; font?: { family: string; weight: number; italic: boolean; size: number; lineHeight: number | null; letterSpacing: number; align: 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFIED'; color: Color };
  imageRef?: string; imageFit?: 'FILL' | 'FIT';
  layout?: { direction: 'HORIZONTAL' | 'VERTICAL'; gap: number; padding: [number, number, number, number]; justify: 'MIN' | 'CENTER' | 'MAX' | 'SPACE_BETWEEN'; align: 'MIN' | 'CENTER' | 'MAX' } };
type Warning = { ref?: string; code: string };
type Snapshot = { nodes: Row[]; images: { ref: string; png: string }[]; warnings: Warning[]; coverage: { complete: boolean } };
const session = `${Date.now()}-${Math.random()}`;
const normalize = (s: string) => s.toLowerCase().replace(/[\s_-]/g, '');
function selectFont(row: Row, available: FontName[]) {
  const font = row.font!;
  const weight = font.weight >= 850 ? 'black' : font.weight >= 750 ? 'extrabold' : font.weight >= 650 ? 'bold' : font.weight >= 550 ? 'semibold' : font.weight >= 450 ? 'medium' : font.weight >= 350 ? 'regular' : font.weight >= 250 ? 'light' : 'thin';
  const style = (weight === 'regular' && font.italic ? '' : weight) + (font.italic ? 'italic' : '');
  const exact = available.find(f => normalize(f.family) === normalize(font.family) && normalize(f.style) === style);
  const chosen = exact ?? available.find(f => f.family === 'Inter' && f.style === 'Regular');
  if (!chosen) throw new Error('WEB_FONT_UNAVAILABLE: Requested font and Inter Regular fallback are unavailable; no layers created');
  return { font: chosen, substituted: !exact };
}
const paint = (color: Color): SolidPaint => ({ type: 'SOLID', color: { r: color.r, g: color.g, b: color.b }, opacity: color.a });

export async function importWebSnapshot(args: Record<string, any>, getNode: (id: string) => Promise<BaseNode>) {
  const snapshot = webSnapshotSchema.parse(args.snapshot) as Snapshot;
  const x = args.x ?? 0, y = args.y ?? 0;
  if (![x, y].every(v => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 100000) ||
    (args.dryRun !== undefined && typeof args.dryRun !== 'boolean')) throw new Error('Invalid web import options');
  const parent = args.parentId ? await getNode(args.parentId) : figma.currentPage;
  if (!['PAGE', 'FRAME', 'SECTION'].includes(parent.type) || ('layoutMode' in parent && parent.layoutMode !== 'NONE'))
    throw new Error('Choose a PAGE, SECTION or frame without Auto Layout as the import destination');
  // Decode/validate everything before a document write. Nothing is fetched from source URLs.
  const bytes = new Map<string, Uint8Array>();
  let totalPixels = 0;
  for (const image of snapshot.images) {
    const data = figma.base64Decode(image.png);
    if (figma.base64Encode(data) !== image.png || data.length < 24 || ![137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => data[i] === v))
      throw new Error('Expected canonical PNG image data');
    const uint = (i: number) => data[i] * 16777216 + data[i + 1] * 65536 + data[i + 2] * 256 + data[i + 3];
    if (String.fromCharCode(...data.slice(12, 16)) !== 'IHDR' || uint(8) !== 13 || !uint(16) || !uint(20) || uint(16) > 4096 || uint(20) > 4096)
      throw new Error('PNG exceeds 4096px per side or has an invalid header');
    totalPixels += uint(16) * uint(20);
    if (totalPixels > 16777216) throw new Error('Snapshot images exceed the 16 megapixel total budget');
    bytes.set(image.ref, data);
  }
  const fonts = new Map<string, ReturnType<typeof selectFont>>();
  const warnings: Warning[] = [...snapshot.warnings];
  const textRows = snapshot.nodes.filter(row => row.kind === 'TEXT');
  const available = textRows.length ? (await figma.listAvailableFontsAsync()).map(entry => entry.fontName) : [];
  for (const row of textRows) {
    const selection = selectFont(row, available); fonts.set(row.ref, selection);
    if (selection.substituted) warnings.push({ ref: row.ref, code: 'font_substituted_with_inter_regular' });
  }
  for (const row of snapshot.nodes) if (row.kind === 'IMAGE' && !row.imageRef) warnings.push({ ref: row.ref, code: 'image_placeholder' });
  const revision = resourceRevision([session, parent.id, x, y, snapshot, [...fonts]]);
  const summary = { parentId: parent.id, nodeCount: snapshot.nodes.length, textCount: textRows.length, imageCount: bytes.size,
    autoLayoutCandidates: snapshot.nodes.filter(row => row.layout).length, coverage: snapshot.coverage,
    warnings, revision, fidelity: 'approximate', visualVerification: 'pending',
    note: 'One editable frame at the captured size. No scripts, links, responsive rules or interactions are imported. Compare a browser screenshot with a Figma export.' };
  if (args.dryRun !== false) return { ...summary, dryRun: true };
  if (!args.revision || args.revision !== revision) throw new Error('WEB_PREVIEW_CHANGED: Preview again with the same snapshot/destination before applying');
  const unique = new Map([...fonts.values()].map(item => [JSON.stringify(item.font), item.font]));
  for (const font of unique.values()) await figma.loadFontAsync(font);
  if (parent.removed || ('layoutMode' in parent && parent.layoutMode !== 'NONE')) throw new Error('Import destination changed while fonts loaded; preview again');
  const images = new Map<string, Image>();
  for (const [ref, data] of bytes) images.set(ref, figma.createImage(data));
  const created: (FrameNode | TextNode | RectangleNode)[] = [], nodes = new Map<string, FrameNode | TextNode | RectangleNode>(), rows = new Map(snapshot.nodes.map(row => [row.ref, row]));
  let autoLayoutCount = 0;
  try {
    for (const row of snapshot.nodes) {
      const node = row.kind === 'TEXT' ? figma.createText() : row.kind === 'FRAME' ? figma.createFrame() : figma.createRectangle();
      created.push(node); nodes.set(row.ref, node);
      const owner = row.parentRef ? nodes.get(row.parentRef)! as FrameNode : parent as PageNode | FrameNode | SectionNode;
      owner.appendChild(node);
      node.name = row.kind === 'TEXT' ? 'Web text' : `Web ${row.name || row.kind}`;
      node.opacity = row.opacity;
      if (node.type === 'TEXT') {
        const font = row.font!;
        node.fontName = fonts.get(row.ref)!.font;
        node.fontSize = font.size;
        node.lineHeight = font.lineHeight === null ? { unit: 'AUTO' } : { unit: 'PIXELS', value: font.lineHeight };
        node.letterSpacing = { unit: 'PIXELS', value: font.letterSpacing };
        node.textAlignHorizontal = font.align;
        node.textAutoResize = 'NONE';
        node.characters = row.text!;
        node.fills = [paint(font.color)];
      } else {
        node.fills = row.imageRef ? [{ type: 'IMAGE', imageHash: images.get(row.imageRef)!.hash, scaleMode: row.imageFit ?? 'FILL' }]
          : row.fill ? [paint(row.fill)] : row.kind === 'IMAGE' ? [paint({ r: 0.9, g: 0.9, b: 0.9, a: 1 })] : [];
        if (row.border) { node.strokes = [paint(row.border.color)]; node.strokeWeight = row.border.width; node.strokeAlign = 'INSIDE'; }
        else node.strokes = [];
        [node.topLeftRadius, node.topRightRadius, node.bottomRightRadius, node.bottomLeftRadius] = row.radii;
        if (node.type === 'FRAME') { node.layoutMode = 'NONE'; node.clipsContent = row.clipsContent; }
      }
      node.resize(row.width, row.height);
      // DOM Range widths can be a fraction smaller than Figma's glyph metrics.
      // Preserve known single lines using natural text size instead of forcing a wrap.
      if (node.type === 'TEXT' && row.textLayout === 'SINGLE_LINE') {
        node.textAutoResize = 'WIDTH_AND_HEIGHT';
        if (Math.abs(node.width - row.width) > 1 || Math.abs(node.height - row.height) > 1)
          warnings.push({ ref: row.ref, code: 'text_metrics_adjusted' });
      }
      const origin = row.parentRef ? rows.get(row.parentRef)! : null;
      node.x = origin ? row.x - origin.x : x;
      node.y = origin ? row.y - origin.y : y;
      // A Range covers the glyph box; Figma's frame includes line-height leading.
      if (node.type === 'TEXT' && row.textLayout === 'SINGLE_LINE') node.y -= (node.height - row.height) / 2;
    }
    for (const row of [...snapshot.nodes].reverse()) {
      if (!row.layout) continue;
      const frame = nodes.get(row.ref)! as FrameNode, layout = row.layout;
      const children = snapshot.nodes.filter(child => child.parentRef === row.ref);
      const geometry = new Map(children.map(child => {
        const n = nodes.get(child.ref)!;
        return [child.ref, { x: n.x, y: n.y, width: n.width, height: n.height }];
      }));
      frame.layoutMode = layout.direction;
      frame.primaryAxisSizingMode = 'FIXED'; frame.counterAxisSizingMode = 'FIXED';
      [frame.paddingTop, frame.paddingRight, frame.paddingBottom, frame.paddingLeft] = layout.padding;
      frame.itemSpacing = layout.gap; frame.primaryAxisAlignItems = layout.justify; frame.counterAxisAlignItems = layout.align;
      frame.resize(row.width, row.height);
      const matches = children.every(child => {
        const n = nodes.get(child.ref)!;
        return Math.abs(n.x - (child.x - row.x)) <= 1 && Math.abs(n.y - (child.y - row.y)) <= 1 &&
          Math.abs(n.width - child.width) <= 1 && Math.abs(n.height - child.height) <= 1;
      });
      if (matches) autoLayoutCount++;
      else {
        frame.layoutMode = 'NONE'; frame.resize(row.width, row.height);
        for (const child of children) {
          const n = nodes.get(child.ref)!, original = geometry.get(child.ref)!;
          if (n.type !== 'TEXT' || child.textLayout !== 'SINGLE_LINE') n.resize(original.width, original.height);
          n.x = original.x; n.y = original.y;
        }
        warnings.push({ ref: row.ref, code: 'auto_layout_fallback_to_coordinates' });
      }
    }
    figma.commitUndo();
    return { ...summary, dryRun: false, rootId: created[0].id, autoLayoutCount,
      nodes: snapshot.nodes.map(row => ({ ref: row.ref, id: nodes.get(row.ref)!.id, kind: row.kind })), warnings };
  } catch (error) {
    const failed: string[] = [];
    for (const node of [...created].reverse()) try { if (!node.removed) node.remove(); } catch { failed.push(node.id); }
    throw new Error(`WEB_IMPORT_FAILED: ${error instanceof Error ? error.message : String(error)}. ${failed.length ? `Cleanup incomplete: ${failed.join(', ')}` : 'New layers removed; existing layers preserved.'} Imported image bytes may remain unreferenced in Figma.`);
  }
}
