export const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6tGQAAAAASUVORK5CYII=';
export const row = (patch = {}) => ({ ref: 'n0', kind: 'FRAME', name: 'main', x: 0, y: 0, width: 400, height: 200,
  opacity: 1, fill: { r: 1, g: 1, b: 1, a: 1 }, border: null, radii: [0, 0, 0, 0], clipsContent: false, ...patch });
export const snapshot = () => ({ format: 'figma-local-web-v1', viewport: { width: 1000, height: 800, scrollX: 0, scrollY: 0 },
  coverage: { complete: true, visited: 3 }, warnings: [], images: [{ ref: 'n2', png }], nodes: [row(),
    row({ ref: 'n1', parentRef: 'n0', kind: 'TEXT', name: 'text', x: 16, y: 16, width: 100, height: 24, fill: null,
      text: 'Hello <script>', font: { family: 'Inter', weight: 400, italic: false, size: 16, lineHeight: 24, letterSpacing: 0,
        align: 'LEFT', color: { r: 0.1, g: 0.2, b: 0.3, a: 0.8 } } }),
    row({ ref: 'n2', parentRef: 'n0', kind: 'IMAGE', name: 'img', x: 16, y: 50, width: 100, height: 100, imageRef: 'n2', imageFit: 'FIT' }),
  ] });
