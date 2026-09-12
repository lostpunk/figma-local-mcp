// Editable native Figma scene. Pass real variable/style IDs returned by create_style_guide.
export function buildStore(colors = {}, styles = {}) {
  const palette = { background: '#FAF9F6', foreground: '#252722', muted: '#72766D', border: '#DEDED5', primary: '#354A38', soft: '#E9ECE3', sand: '#E9E1D6', white: '#FFFFFF' };
  const sizes = { Display: 66, Heading: 32, Body: 16, Label: 12, Product: 18 };
  const nodes = [];
  const paint = color => colors[color] ? { fillVariableId: colors[color] } : { fill: palette[color] ?? color };
  function box(ref, parentRef, x, y, width, height, color, extra = {}, type = 'RECTANGLE') {
    nodes.push({ ref, ...(parentRef ? { parentRef } : {}), type, props: { name: ref, x, y, width, height, ...paint(color), ...extra } });
  }
  function text(ref, parentRef, x, y, characters, style = 'Body', color = 'foreground', extra = {}) {
    nodes.push({ ref, parentRef, type: 'TEXT', props: { name: ref, x, y, characters, textAutoResize: 'WIDTH_AND_HEIGHT', ...(styles[style] ? { textStyleId: styles[style] } : { fontSize: sizes[style] }), ...paint(color), ...extra } });
  }
  function shirt(ref, parent, x, y, scale, color, back, jacket = false) {
    box(ref, parent, x, y, 240 * scale, 270 * scale, back, { clipsContent: false, fill: ref === 'Overshirt illustration' ? null : back }, 'FRAME');
    box(ref + '/shadow', ref, 38 * scale, 243 * scale, 166 * scale, 14 * scale, '#000000', { opacity: .07 }, 'ELLIPSE');
    box(ref + '/left-sleeve', ref, 13 * scale, 82 * scale, 77 * scale, 105 * scale, color, { rotation: 26, cornerRadius: 9 * scale });
    box(ref + '/right-sleeve', ref, 158 * scale, 48 * scale, 77 * scale, 105 * scale, color, { rotation: -26, cornerRadius: 9 * scale });
    box(ref + '/body', ref, 63 * scale, 48 * scale, 126 * scale, 195 * scale, color, { cornerRadius: 10 * scale });
    box(ref + '/neck', ref, 100 * scale, 34 * scale, 52 * scale, 36 * scale, ref === 'Overshirt illustration' ? '#CDD4C2' : back, {}, 'ELLIPSE');
    box(ref + '/hem', ref, 69 * scale, 229 * scale, 114 * scale, 2 * scale, '#000000', { opacity: .12 });
    if (jacket) {
      box(ref + '/seam', ref, 125 * scale, 70 * scale, 2 * scale, 160 * scale, '#000000', { opacity: .2 });
      box(ref + '/pocket', ref, 141 * scale, 98 * scale, 33 * scale, 35 * scale, color, { stroke: '#777C6B', strokeWeight: scale });
      for (let i = 0; i < 4; i++) box(ref + '/button-' + i, ref, 122 * scale, (91 + i * 36) * scale, 5 * scale, 5 * scale, '#30382C', {}, 'ELLIPSE');
    }
  }

  box('FORM / Desktop', null, 0, 0, 1440, 1560, 'background', { clipsContent: true }, 'FRAME');
  const root = 'FORM / Desktop';
  box('Announcement', root, 0, 0, 1440, 34, 'primary', {}, 'FRAME');
  text('Delivery message', 'Announcement', 472, 8, 'Бесплатная доставка для заказов от 8 000 ₽', 'Label', 'white');
  text('Brand', root, 64, 56, 'FORM', 'Heading');
  text('Navigation', root, 464, 67, 'Новинки       Женщинам       Мужчинам       О бренде', 'Body');
  text('Utilities', root, 1160, 67, 'Поиск      Корзина (0)', 'Body');
  box('Header divider', root, 64, 111, 1312, 1, 'border');

  box('Hero', root, 64, 144, 1312, 530, 'soft', { cornerRadius: 8, clipsContent: true }, 'FRAME');
  text('Season', 'Hero', 48, 46, 'НОВАЯ КОЛЛЕКЦИЯ  /  ОСЕНЬ 2026', 'Label', 'primary');
  text('Hero title', 'Hero', 48, 105, 'Меньше лишнего.\nБольше тебя.', 'Display');
  text('Hero description', 'Hero', 48, 287, 'Одежда на каждый день, в которой легко быть собой.\nПродуманный крой, природные оттенки, мягкие ткани.', 'Body', 'muted');
  box('Primary button', 'Hero', 48, 379, 241, 52, 'primary', { cornerRadius: 4, layoutMode: 'HORIZONTAL', itemSpacing: 20, paddingLeft: 22, paddingRight: 22, counterAxisAlignItems: 'CENTER', primaryAxisAlignItems: 'CENTER' }, 'COMPONENT');
  text('CTA label', 'Primary button', 0, 0, 'Смотреть коллекцию   ↗', 'Body', 'white');
  text('Hero caption', 'Hero', 48, 477, 'БАЗОВЫЕ ВЕЩИ. ОСОБЕННЫЕ ДЕТАЛИ.', 'Label', 'muted');
  box('Hero art', 'Hero', 745, 0, 567, 530, '#DDE1D4', {}, 'FRAME');
  box('Art circle', 'Hero art', 50, 46, 440, 440, '#CDD4C2', {}, 'ELLIPSE');
  shirt('Overshirt illustration', 'Hero art', 116, 39, 1.45, '#859076', '#DDE1D4', true);
  text('Art annotation', 'Hero art', 34, 477, '01 / РУБАШКА ИЗ ПЛОТНОГО ХЛОПКА', 'Label', 'primary');

  text('Collection heading', root, 64, 728, 'Твои новые любимые', 'Heading');
  text('Collection subheading', root, 64, 778, 'Простые формы. Сотни сочетаний.', 'Body', 'muted');
  text('View all', root, 1218, 743, 'Все новинки  ↗', 'Body');

  const products = [
    { name: 'Футболка Essential', material: '100% органический хлопок', price: '2 900 ₽', color: '#F8F5EE', bg: '#E8E2D9', swatches: ['#F8F5EE', '#343630', '#A2A591'] },
    { name: 'Рубашка Relaxed', material: 'Плотный хлопок · свободный крой', price: '5 900 ₽', color: '#859076', bg: '#E3E7DD', jacket: true, swatches: ['#859076', '#D5C9B2', '#343630'] },
    { name: 'Лонгслив Everyday', material: 'Мягкий трикотаж · унисекс', price: '3 900 ₽', color: '#454A43', bg: '#E5E4E0', swatches: ['#454A43', '#F8F5EE', '#B3A38B'] },
    { name: 'Футболка Sand', material: 'Дышащий хлопок · relaxed fit', price: '2 900 ₽', color: '#BBA68B', bg: '#EFE7DB', swatches: ['#BBA68B', '#F8F5EE', '#454A43'] },
  ];
  const productBatches = products.map((p, i) => {
    const start = nodes.length;
    const ref = `Product ${i + 1}`;
    box(ref, null, i * 338, 0, 298, 444, 'background', {}, 'COMPONENT');
    box(ref + '/media', ref, 0, 0, 298, 322, p.bg, { cornerRadius: 8 }, 'FRAME');
    shirt(ref + '/illustration', ref + '/media', 31, 29, .94, p.color, p.bg, p.jacket);
    text(ref + '/badge', ref + '/media', 16, 14, i === 0 ? 'БЕСТСЕЛЛЕР' : 'НОВИНКА', 'Label');
    text(ref + '/name', ref, 0, 340, p.name, 'Product');
    text(ref + '/price', ref, 213, 343, p.price, 'Body');
    text(ref + '/material', ref, 0, 372, p.material, 'Label', 'muted');
    p.swatches.forEach((c, j) => box(ref + '/swatch-' + j, ref, j * 24, 405, 16, 16, c, { stroke: '#CBCBC1', strokeWeight: 1 }, 'ELLIPSE'));
    return nodes.splice(start);
  });

  box('Brand note', root, 64, 1302, 1312, 150, 'sand', { cornerRadius: 8 }, 'FRAME');
  text('Brand note title', 'Brand note', 32, 27, 'Хорошие вещи остаются надолго.', 'Heading');
  text('Brand note copy', 'Brand note', 32, 82, 'Создаём основу гардероба, к которой хочется возвращаться каждый день.', 'Body', 'muted');
  text('Brand note link', 'Brand note', 1107, 67, 'Наш подход  ↗', 'Body');
  box('Footer divider', root, 64, 1490, 1312, 1, 'border');
  text('Copyright', root, 64, 1512, '© FORM, 2026', 'Label', 'muted');
  text('Footer links', root, 974, 1512, 'Доставка и оплата       Возврат       Контакты', 'Label', 'muted');
  return { screen: nodes, products: productBatches, instances: products.map((_, i) => ({ x: 64 + i * 338, y: 839 })) };
}
