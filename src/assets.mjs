import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute } from 'node:path';
import { SaxesParser } from 'saxes';

export const IMAGE_LIMIT = 8 * 1024 * 1024;
export const SVG_LIMIT = 1024 * 1024;

async function readBounded(path, limit) {
  if (!isAbsolute(path)) throw new Error('filePath must be an absolute local path');
  // Nonblocking open prevents a named pipe from hanging before the regular-file check.
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error(`Expected a regular file of at most ${limit} bytes`);
    const buffer = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > limit) throw new Error('Asset exceeds size limit');
    return buffer.subarray(0, size);
  } finally { await file.close(); }
}

export function validateSvg(svg) {
  if (!svg || Buffer.byteLength(svg) > SVG_LIMIT) throw new Error('SVG must be nonempty and at most 1 MiB');
  const tags = new Set(['svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
    'defs', 'linearGradient', 'radialGradient', 'stop', 'clipPath', 'mask', 'title', 'desc', 'use']);
  let count = 0;
  let depth = 0;
  const parser = new SaxesParser({ xmlns: true });
  parser.on('doctype', () => { throw new Error('SVG must not contain a DOCTYPE'); });
  parser.on('processinginstruction', () => { throw new Error('SVG processing instructions are not supported'); });
  parser.on('opentag', node => {
    if (++count > 5000 || ++depth > 64) throw new Error('SVG exceeds 5000 elements or 64 nesting levels');
    if (count === 1 && node.local !== 'svg') throw new Error('Expected an SVG root element');
    if (!tags.has(node.local) || (node.uri && node.uri !== 'http://www.w3.org/2000/svg')) {
      throw new Error(`Unsupported SVG element: ${node.name}. Use static vector shapes; import raster images separately.`);
    }
    for (const attr of Object.values(node.attributes)) {
      if (attr.uri === 'http://www.w3.org/2000/xmlns/') continue;
      if (/^on/i.test(attr.local) || attr.local === 'base') throw new Error('SVG event handlers and base URLs are not supported');
      if (attr.local === 'href' && !/^#[A-Za-z_][\w.:-]*$/.test(attr.value)) throw new Error('SVG references must be local #ids');
      if (/[\\@]/.test(attr.value) || /(?:javascript|data|https?|file):|expression\s*\(/i.test(attr.value)) {
        throw new Error('SVG external resources and executable styles are not supported');
      }
      const withoutLocalUrls = attr.value.replace(/url\(\s*['"]?#[A-Za-z_][\w.:-]*['"]?\s*\)/gi, '');
      if (/url\s*\(/i.test(withoutLocalUrls)) throw new Error('SVG paint references must be local #ids');
    }
  });
  parser.on('closetag', () => { depth--; });
  parser.write(svg).close();
  return svg;
}

export async function prepareAsset(command, args) {
  if (command !== 'import_image' && command !== 'import_svg') return args;
  const inline = command === 'import_image' ? args.dataBase64 : args.svg;
  if (Number(args.filePath !== undefined) + Number(inline !== undefined) !== 1) {
    throw new Error('Provide exactly one source: filePath or inline asset data');
  }
  const { filePath, ...prepared } = args;
  if (command === 'import_svg') {
    const svg = filePath ? new TextDecoder('utf-8', { fatal: true }).decode(await readBounded(filePath, SVG_LIMIT)) : args.svg;
    return { ...prepared, svg: validateSvg(svg) };
  }
  if (args.nodeId && ['parentId', 'name', 'x', 'y', 'width', 'height'].some(key => args[key] !== undefined)) {
    throw new Error('With nodeId, only the image fill is replaced; omit parent and geometry arguments');
  }
  const bytes = filePath ? await readBounded(filePath, IMAGE_LIMIT) : Buffer.from(args.dataBase64, 'base64');
  if (!filePath && bytes.toString('base64') !== args.dataBase64) throw new Error('Expected canonical base64 without a data URL prefix');
  if (!bytes.length || bytes.length > IMAGE_LIMIT) throw new Error('Image must be nonempty and at most 8 MiB');
  const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const gif = ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'));
  if (!png && !jpeg && !gif) throw new Error('Supported image formats: PNG, JPEG and GIF');
  return { ...prepared, dataBase64: bytes.toString('base64') };
}
