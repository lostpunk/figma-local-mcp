// Self-contained DOM reader. No requests, script extraction, storage, form values or page mutations.
export function captureWebPage(options = {}) {
  const maxNodes = options.maxNodes ?? 200;
  if (!Number.isInteger(maxNodes) || maxNodes < 1 || maxNodes > 200) throw new Error('maxNodes must be 1–200');
  const root = document.querySelector(options.selector ?? 'body');
  if (!root) throw new Error('Capture root not found');
  const box = root.getBoundingClientRect();
  if (!box.width || !box.height || box.width > 20000 || box.height > 20000) throw new Error('Choose a visible section no larger than 20000px per side');
  const nodes = [], images = [], warnings = [], elements = new Map();
  let visited = 0, complete = true, reason, imageBytes = 0, imagePixels = 0;
  const warn = (code, ref) => { if (warnings.length < 500) warnings.push({ ...(ref ? { ref } : {}), code }); else { complete = false; reason = 'warning_limit'; } };
  const number = value => Number.parseFloat(value) || 0;
  const rgba = value => {
    if (!value || value === 'transparent') return null;
    const m = value.match(/^rgba?\(\s*([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/);
    if (!m) return null;
    const c = { r: Math.min(1, +m[1] / 255), g: Math.min(1, +m[2] / 255), b: Math.min(1, +m[3] / 255), a: m[4] === undefined ? 1 : Math.min(1, +m[4]) };
    return c.a ? c : null;
  };
  const empty = { r: 0, g: 0, b: 0, a: 0 };
  const geometry = rect => ({ x: rect.left - box.left, y: rect.top - box.top, width: rect.width, height: rect.height });
  const add = row => { nodes.push(row); return row; };
  function room() {
    if (nodes.length >= maxNodes || visited >= 10000) { complete = false; reason = nodes.length >= maxNodes ? 'node_limit' : 'traversal_limit'; return false; }
    return true;
  }
  function walk(el, parentRef, depth, carriedOpacity = 1) {
    if (!room()) return;
    visited++;
    if (depth > 40) { complete = false; reason = 'depth_limit'; return; }
    const tag = el.tagName.toLowerCase();
    if (['script', 'style', 'link', 'meta', 'head', 'noscript', 'template'].includes(tag)) return;
    const s = getComputedStyle(el), rect = el.getBoundingClientRect();
    if (s.display === 'none' || (s.display !== 'contents' && number(s.opacity) === 0)) return;
    // Keep form outlines, but never inspect their content, including through boxless wrappers.
    const contentOmission = s.webkitTextSecurity && s.webkitTextSecurity !== 'none' ? 'masked_text_omitted'
      : el.isContentEditable || ['input', 'textarea', 'select', 'iframe', 'canvas', 'video', 'svg', 'object', 'embed'].includes(tag)
        ? 'embedded_or_form_content_omitted' : null;
    if (s.display === 'contents' || !rect.width || !rect.height) {
      if (contentOmission) { warn(contentOmission, parentRef); return; }
      // A missing own box does not imply missing descendant boxes. Keep their captured coordinates.
      // Zero-sized clipping cannot be represented by our positive-size snapshot frames.
      if (s.display !== 'contents' && ['hidden', 'scroll', 'auto', 'clip'].some(v => [s.overflowX, s.overflowY].includes(v))) {
        complete = false; reason = 'unsupported_clipping'; warn('boxless_clipping_omitted', parentRef); return;
      }
      warn('boxless_container_flattened', parentRef);
      if (el.shadowRoot) warn('shadow_dom_omitted', parentRef);
      const opacity = carriedOpacity * (s.display === 'contents' ? 1 : number(s.opacity));
      if (opacity !== 1) warn('flattened_group_opacity_approximate', parentRef);
      walkChildren(el, s, parentRef, depth, opacity);
      return;
    }
    const ownVisible = s.visibility === 'visible';
    if (!ownVisible && tag === 'img') return;
    if (rect.width > 20000 || rect.height > 20000 || Math.abs(rect.x - box.x) > 100000 || Math.abs(rect.y - box.y) > 100000) {
      complete = false; warn('element_bounds_omitted', parentRef); return;
    }
    const ref = `n${nodes.length}`, kind = tag === 'img' ? 'IMAGE' : 'FRAME';
    const widths = ['Top', 'Right', 'Bottom', 'Left'].map(side => number(s[`border${side}Width`]));
    const borderColor = rgba(s.borderTopColor);
    const uniformBorder = widths.every(w => w === widths[0]) && ['Top', 'Right', 'Bottom', 'Left'].every(side => s[`border${side}Color`] === s.borderTopColor && ['solid', 'none'].includes(s[`border${side}Style`]));
    if (!uniformBorder && widths.some(Boolean)) warn('nonuniform_border_omitted', ref);
    const radii = ['borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomRightRadius', 'borderBottomLeftRadius'].map(key => {
      if (s[key].includes('%') || s[key].includes(' ')) { warn('complex_radius_approximated', ref); return 0; }
      return Math.min(10000, number(s[key]));
    });
    const row = add({ ref, ...(parentRef ? { parentRef } : {}), kind, name: tag,
      ...geometry(rect), opacity: carriedOpacity * number(s.opacity), fill: ownVisible ? rgba(s.backgroundColor) : null,
      border: ownVisible && uniformBorder && widths[0] && borderColor ? { color: borderColor, width: Math.min(1000, widths[0]) } : null,
      radii, clipsContent: ['hidden', 'scroll', 'auto', 'clip'].some(v => [s.overflowX, s.overflowY].includes(v)) });
    elements.set(ref, { el, s });
    if (!parentRef && !row.fill) warn('root_background_transparent', ref);
    if (ownVisible && !row.fill && s.backgroundColor !== 'transparent' && s.backgroundColor !== 'rgba(0, 0, 0, 0)') warn('unsupported_background_color', ref);
    if (s.backgroundImage !== 'none') warn('background_image_or_gradient_omitted', ref);
    if (s.boxShadow !== 'none') warn('shadow_omitted', ref);
    if (s.transform !== 'none') warn('transform_flattened_to_bounds', ref);
    if (s.filter !== 'none' || s.backdropFilter && s.backdropFilter !== 'none') warn('filter_omitted', ref);
    if (s.clipPath !== 'none' || s.maskImage && s.maskImage !== 'none' || s.mixBlendMode !== 'normal') warn('mask_clip_or_blend_omitted', ref);
    if (s.zIndex !== 'auto') warn('stacking_order_approximate', ref);
    if (s.position === 'fixed' || s.position === 'sticky') warn('scroll_position_frozen', ref);
    if (s.animationName !== 'none') warn('animation_frozen', ref);
    if (s.display.includes('grid')) warn('grid_uses_coordinates', ref);
    if (s.writingMode !== 'horizontal-tb' || s.direction === 'rtl') warn('text_direction_approximate', ref);
    for (const pseudo of ['::before', '::after']) {
      const style = getComputedStyle(el, pseudo), content = style.content;
      if (content && !['none', 'normal'].includes(content) && (content !== '""' || style.backgroundImage !== 'none' || rgba(style.backgroundColor) || number(style.borderTopWidth) || number(style.width) || number(style.height))) warn('pseudo_element_omitted', ref);
    }
    if (el.shadowRoot) warn('shadow_dom_omitted', ref);
    if (contentOmission) { warn(contentOmission, ref); return; }
    if (kind === 'IMAGE') {
      row.imageFit = s.objectFit === 'contain' ? 'FIT' : 'FILL';
      if (!['contain', 'cover'].includes(s.objectFit) || s.objectPosition !== '50% 50%') warn('image_fit_approximate', ref);
      try {
        if (!el.complete || !el.naturalWidth || !el.naturalHeight) throw new Error('not_loaded');
        if (el.naturalWidth > 4096 || el.naturalHeight > 4096 || imagePixels + el.naturalWidth * el.naturalHeight > 16777216 || images.length >= 40) throw new Error('bounds');
        const canvas = document.createElement('canvas');
        canvas.width = el.naturalWidth; canvas.height = el.naturalHeight;
        canvas.getContext('2d').drawImage(el, 0, 0);
        const png = canvas.toDataURL('image/png').split(',')[1];
        if (!png || png.length > 2 * 1024 * 1024 || imageBytes + png.length > 3 * 1024 * 1024) throw new Error('budget');
        imageBytes += png.length; imagePixels += el.naturalWidth * el.naturalHeight; images.push({ ref, png }); row.imageRef = ref;
      } catch { warn('image_pixels_unavailable', ref); }
      return;
    }
    walkChildren(el, s, ref, depth, 1);
  }
  function walkChildren(el, s, ref, depth, carriedOpacity) {
    for (const child of el.childNodes) {
      if (!room()) break;
      if (child.nodeType === 1) { walk(child, ref, depth + 1, carriedOpacity); continue; }
      if (child.nodeType !== 3) continue;
      visited++;
      if (s.visibility !== 'visible' || !child.textContent?.trim()) continue;
      const range = document.createRange(); range.selectNodeContents(child);
      const bounds = range.getBoundingClientRect();
      if (!bounds.width || !bounds.height) continue;
      let text = child.textContent;
      if (!s.whiteSpace.startsWith('pre') && s.whiteSpace !== 'break-spaces') text = text.replace(/\s+/g, ' ');
      const textRef = `n${nodes.length}`;
      if (text.length > 2000) { text = text.slice(0, 2000); if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1); warn('text_truncated', textRef); complete = false; }
      const wrapped = range.getClientRects().length > 1 || /[\r\n]/.test(text);
      if (wrapped) warn('wrapped_text_metrics_approximate', textRef);
      if (s.textTransform !== 'none' || s.textDecorationLine !== 'none') warn('text_decoration_or_transform_omitted', textRef);
      if (bounds.width > 20000 || bounds.height > 20000) { warn('text_bounds_omitted', ref); complete = false; continue; }
      const color = rgba(s.color);
      if (!color) warn('unsupported_text_color', textRef);
      add({ ref: textRef, parentRef: ref, kind: 'TEXT', name: 'text', ...geometry(bounds), opacity: carriedOpacity,
        fill: null, border: null, radii: [0, 0, 0, 0], clipsContent: false, text,
        textLayout: wrapped ? 'WRAPPED' : 'SINGLE_LINE',
        font: { family: s.fontFamily.split(',')[0].trim().replace(/^['"]|['"]$/g, '').slice(0, 200),
          weight: Math.min(900, Math.max(100, Math.round(number(s.fontWeight)) || 400)), italic: s.fontStyle !== 'normal',
          size: Math.min(1000, Math.max(1, number(s.fontSize))), lineHeight: s.lineHeight === 'normal' ? null : Math.min(2000, Math.max(1, number(s.lineHeight))),
          letterSpacing: Math.min(100, Math.max(-100, number(s.letterSpacing))),
          align: ({ center: 'CENTER', right: 'RIGHT', end: 'RIGHT', justify: 'JUSTIFIED' })[s.textAlign] ?? 'LEFT', color: color ?? empty } });
    }
  }
  walk(root, undefined, 0);
  if (!nodes.length) throw new Error('Capture root is not visible');
  nodes[0].x = 0; nodes[0].y = 0;
  // Infer only simple non-wrapping flex layouts; Figma verifies resulting child geometry before keeping them.
  for (const row of nodes) {
    const entry = elements.get(row.ref);
    if (!entry || row.kind !== 'FRAME') continue;
    const { s } = entry;
    if (!['flex', 'inline-flex'].includes(s.display)) continue;
    const children = nodes.filter(n => n.parentRef === row.ref);
    const plain = children.length && children.every(n => {
      const c = elements.get(n.ref)?.s;
      return c && ['static', 'relative'].includes(c.position) && c.transform === 'none' && c.order === '0'
        && ['marginTop', 'marginRight', 'marginBottom', 'marginLeft'].every(key => number(c[key]) === 0);
    });
    const justify = ({ 'flex-start': 'MIN', start: 'MIN', normal: 'MIN', center: 'CENTER', 'flex-end': 'MAX', end: 'MAX', 'space-between': 'SPACE_BETWEEN' })[s.justifyContent];
    const align = ({ 'flex-start': 'MIN', start: 'MIN', stretch: 'MIN', normal: 'MIN', center: 'CENTER', 'flex-end': 'MAX', end: 'MAX' })[s.alignItems];
    const gap = s.flexDirection === 'row' ? s.columnGap : s.rowGap;
    if (!complete || !plain || !['row', 'column'].includes(s.flexDirection) || s.flexWrap !== 'nowrap' || row.border || !justify || !align || gap.includes('%')) { warn('flex_uses_coordinates', row.ref); continue; }
    row.layout = { direction: s.flexDirection === 'row' ? 'HORIZONTAL' : 'VERTICAL', gap: Math.max(0, number(gap)),
      padding: ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'].map(key => Math.max(0, number(s[key]))), justify, align };
  }
  const snapshot = { format: 'figma-local-web-v1', viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY },
    coverage: { complete, visited, ...(reason ? { reason } : {}) }, nodes, images, warnings };
  if (new TextEncoder().encode(JSON.stringify(snapshot)).byteLength > 4 * 1024 * 1024) throw new Error('Capture exceeds 4 MiB; select a smaller section');
  return snapshot;
}
