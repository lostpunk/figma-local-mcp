import { readAllowedAsset } from './asset-access.mjs';
import { SaxesParser } from 'saxes';

export const IMAGE_LIMIT = 8 * 1024 * 1024;
export const SVG_LIMIT = 1024 * 1024;

export function validateSvg(svg) {
  if (!svg || Buffer.byteLength(svg) > SVG_LIMIT) throw new Error('SVG must be nonempty and at most 1 MiB');
  const tags = new Set(['svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
    'defs', 'linearGradient', 'radialGradient', 'stop', 'clipPath', 'mask', 'title', 'desc', 'use']);
  let count = 0;
  let depth = 0;
  const presentation = new Set(['fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity',
    'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset',
    'opacity', 'clip-path', 'clip-rule', 'mask', 'mask-type', 'stop-color', 'stop-opacity', 'color',
    'vector-effect', 'display', 'visibility', 'shape-rendering', 'color-interpolation']);
  const attributes = new Set([...presentation, 'id', 'class', 'version', 'viewBox', 'width', 'height',
    'x', 'y', 'x1', 'x2', 'y1', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'fx', 'fy', 'fr', 'd', 'points',
    'transform', 'preserveAspectRatio', 'maskUnits', 'maskContentUnits', 'clipPathUnits', 'gradientUnits',
    'gradientTransform', 'spreadMethod', 'offset', 'href', 'style', 'aria-hidden', 'aria-label', 'role', 'focusable']);
  const elements = [], stack = [], ids = new Map();
  const parser = new SaxesParser({ xmlns: true });
  parser.on('doctype', () => { throw new Error('SVG must not contain a DOCTYPE'); });
  parser.on('processinginstruction', () => { throw new Error('SVG processing instructions are not supported'); });
  parser.on('opentag', node => {
    if (++count > 5000 || ++depth > 64) throw new Error('SVG exceeds 5000 elements or 64 nesting levels');
    if (count === 1 && node.local !== 'svg') throw new Error('Expected an SVG root element');
    if (!tags.has(node.local) || (node.uri && node.uri !== 'http://www.w3.org/2000/svg')) {
      throw new Error(`Unsupported SVG element: ${node.name}. Use static vector shapes; import raster images separately.`);
    }
    const element = { children: [], references: [] };
    if (stack.length) stack.at(-1).children.push(element);
    stack.push(element); elements.push(element);
    for (const attr of Object.values(node.attributes)) {
      if (attr.uri === 'http://www.w3.org/2000/xmlns/') continue;
      if (/^on/i.test(attr.local) || attr.local === 'base') throw new Error('SVG event handlers and base URLs are not supported');
      if ((attr.uri && !(attr.uri === 'http://www.w3.org/1999/xlink' && attr.local === 'href')) || !attributes.has(attr.local)) {
        throw new Error('Unsupported SVG attribute; use static geometry and presentation attributes');
      }
      if (attr.local === 'id') {
        if (!/^[A-Za-z_][\w.:-]*$/.test(attr.value) || ids.has(attr.value)) throw new Error('SVG IDs must be valid and unique');
        ids.set(attr.value, element);
      }
      if (attr.local === 'href' && !/^#[A-Za-z_][\w.:-]*$/.test(attr.value)) throw new Error('SVG references must be local #ids');
      if (attr.local === 'href') {
        if (!['use', 'linearGradient', 'radialGradient'].includes(node.local)) throw new Error('SVG href is supported only on use and gradients');
        element.references.push(attr.value.slice(1));
      }
      if (/[\\@]/.test(attr.value) || /(?:javascript|data|https?|file):|expression\s*\(/i.test(attr.value)) {
        throw new Error('SVG external resources and executable styles are not supported');
      }
      if (attr.local === 'style') {
        if (/\/\*|\*\//.test(attr.value)) throw new Error('SVG CSS comments are not supported');
        for (const declaration of attr.value.split(';').filter(value => value.trim())) {
          const colon = declaration.indexOf(':');
          if (colon < 0 || !presentation.has(declaration.slice(0, colon).trim().toLowerCase())) {
            throw new Error('SVG style supports only static presentation properties');
          }
        }
      }
      const withoutLocalUrls = attr.value.replace(/url\(\s*(?:"#([A-Za-z_][\w.:-]*)"|'#([A-Za-z_][\w.:-]*)'|#([A-Za-z_][\w.:-]*))\s*\)/gi,
        (_match, doubleQuoted, singleQuoted, unquoted) => { element.references.push(doubleQuoted ?? singleQuoted ?? unquoted); return ''; });
      if (/url\s*\(/i.test(withoutLocalUrls)) throw new Error('SVG paint references must be local #ids');
      // CSS functions outside this small paint subset can introduce additional URL grammars.
      if (presentation.has(attr.local) || attr.local === 'style') {
        const functions = withoutLocalUrls.matchAll(/([a-zA-Z_-][\w-]*)\s*\(/g);
        for (const [, name] of functions) if (!['rgb', 'rgba', 'hsl', 'hsla'].includes(name.toLowerCase())) {
          throw new Error('Unsupported SVG paint function');
        }
      }
    }
  });
  parser.on('closetag', () => { depth--; stack.pop(); });
  parser.write(svg).close();
  // An acyclic <use> graph can still expand exponentially. Count its expanded
  // cost with memoization, including containment and paint references.
  const visiting = new Set(), costs = new Map();
  function cost(element, level = 0) {
    if (visiting.has(element)) throw new Error('Cyclic SVG reference');
    if (level > 128) throw new Error('SVG reference nesting exceeds limit');
    if (costs.has(element)) return costs.get(element);
    visiting.add(element);
    let total = 1;
    const linked = element.references.map(id => {
      if (!ids.has(id)) throw new Error('SVG reference target does not exist');
      return ids.get(id);
    });
    for (const child of [...element.children, ...linked]) {
      total += cost(child, level + 1);
      if (total > 20000) throw new Error('SVG expanded references exceed 20000 elements');
    }
    visiting.delete(element); costs.set(element, total); return total;
  }
  cost(elements[0]);
  return svg;
}

export async function prepareAsset(command, args, allowedRoots = []) {
  if (command !== 'import_image' && command !== 'import_svg') return args;
  const inline = command === 'import_image' ? args.dataBase64 : args.svg;
  if (Number(args.filePath !== undefined) + Number(inline !== undefined) !== 1) {
    throw new Error('Provide exactly one source: filePath or inline asset data');
  }
  const { filePath, ...prepared } = args;
  if (command === 'import_svg') {
    const svg = filePath ? new TextDecoder('utf-8', { fatal: true }).decode(await readAllowedAsset(filePath, SVG_LIMIT, allowedRoots)) : args.svg;
    return { ...prepared, svg: validateSvg(svg) };
  }
  if (args.nodeId && ['parentId', 'name', 'x', 'y', 'width', 'height'].some(key => args[key] !== undefined)) {
    throw new Error('With nodeId, only the image fill is replaced; omit parent and geometry arguments');
  }
  const bytes = filePath ? await readAllowedAsset(filePath, IMAGE_LIMIT, allowedRoots) : Buffer.from(args.dataBase64, 'base64');
  if (!filePath && bytes.toString('base64') !== args.dataBase64) throw new Error('Expected canonical base64 without a data URL prefix');
  if (!bytes.length || bytes.length > IMAGE_LIMIT) throw new Error('Image must be nonempty and at most 8 MiB');
  const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const gif = ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'));
  if (!png && !jpeg && !gif) throw new Error('Supported image formats: PNG, JPEG and GIF');
  return { ...prepared, dataBase64: bytes.toString('base64') };
}
