import vm from 'node:vm';
import { readFileSync } from 'node:fs';

export function pluginHarness({ clock = Date } = {}) {
  const nodes = new Map();
  const messages = [];
  const fonts = [];
  const variables = new Map();
  const collections = new Map();
  const styles = new Map();
  let nextId = 10;
  let undoCount = 0;
  function node(type, name, parent) {
    const result = {
      id: `${nextId++}:1`, type, name, parent: null, removed: false,
      remove() {
        for (const child of [...(this.children ?? [])]) child.remove();
        this.removed = true;
        if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);
        nodes.delete(this.id);
      },
    };
    if (['DOCUMENT', 'PAGE', 'FRAME', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE'].includes(type)) {
      result.children = [];
      result.appendChild = child => {
        if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1);
        child.parent = result;
        result.children.push(child);
      };
      result.insertChild = (index, child) => {
        if (!Number.isInteger(index) || index < 0 || index > result.children.length) throw new Error('Invalid child index');
        if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1);
        child.parent = result;
        result.children.splice(index, 0, child);
      };
    }
    if (type === 'PAGE') {
      result.flowStartingPoints = [];
      result.backgrounds = [];
      result.selection = [];
      result.loadAsync = async () => { result.loaded = true; };
    } else if (type !== 'DOCUMENT') {
      Object.assign(result, { x: 0, y: 0, width: 100, height: 100, rotation: 0,
        boundVariables: {},
        setBoundVariable(field, variable) {
          if (variable) this.boundVariables[field] = { type: 'VARIABLE_ALIAS', id: variable.id };
          else delete this.boundVariables[field];
        },
        visible: true, locked: false, opacity: 1, fills: [], strokes: [], strokeWeight: 1,
        reactions: [], effects: [],
        async setReactionsAsync(reactions) { this.reactions = reactions; },
        absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 },
        resize(width, height) { this.width = width; this.height = height; },
        async exportAsync(settings) {
          this.lastExport = settings;
          return settings.format === 'SVG_STRING' ? '<svg/>' : new Uint8Array([137, 80, 78, 71]);
        },
      });
      Object.defineProperty(result, 'relativeTransform', {
        get() {
          const matrix = this._relativeTransform ?? [[1, 0, 0], [0, 1, 0]];
          return [[matrix[0][0], matrix[0][1], this.x], [matrix[1][0], matrix[1][1], this.y]];
        },
        set(value) { this._relativeTransform = value; this.x = value[0][2]; this.y = value[1][2]; },
      });
      Object.defineProperty(result, 'absoluteTransform', {
        get() {
          const [[a,c,x],[b,d,y]] = this.parent?.absoluteTransform ?? [[1,0,0],[0,1,0]];
          const [[e,g,u],[f,h,v]] = this.relativeTransform;
          return [[a*e+c*f, a*g+c*h, a*u+c*v+x], [b*e+d*f, b*g+d*h, b*u+d*v+y]];
        },
      });
      if (type !== 'ELLIPSE') Object.assign(result, { cornerRadius: 0,
        topLeftRadius: 0, topRightRadius: 0, bottomLeftRadius: 0, bottomRightRadius: 0 });
      if (['FRAME', 'COMPONENT', 'INSTANCE'].includes(type)) Object.assign(result, { layoutMode: 'NONE', primaryAxisSizingMode: 'AUTO', itemSpacing: 0,
        paddingTop: 0, paddingBottom: 0, paddingLeft: 0, paddingRight: 0, clipsContent: true });
      if (type === 'TEXT') Object.assign(result, { characters: '', fontName: { family: 'Inter', style: 'Regular' },
        fontSize: 12, textAlignHorizontal: 'LEFT', textAutoResize: 'NONE', lineHeight: { unit: 'AUTO' }, textStyleId: '', textWrapStyle: 'AUTO',
        async setTextStyleIdAsync(id) {
          if (id === '') { this.textStyleId = ''; return; }
          const style = styles.get(id);
          if (!style) throw new Error('Missing text style');
          this.textStyleId = id;
          this.fontName = style.fontName;
          this.fontSize = style.fontSize;
          this.lineHeight = style.lineHeight;
          this.textWrapStyle = style.textWrapStyle;
        },
        getRangeAllFontNames(start, end) {
          if (end <= start) throw new Error('Empty range selected');
          return Object.freeze(this.rangeFonts ?? [this.fontName]);
        },
      });
    }
    nodes.set(result.id, result);
    result.clone = () => {
      const copy = node(type, result.name, result.parent);
      for (const key of ['width', 'height', 'x', 'y', 'fills', 'strokes', 'characters', 'fontName']) {
        if (key in result) copy[key] = JSON.parse(JSON.stringify(result[key]));
      }
      for (const child of [...(result.children ?? [])]) copy.appendChild(child.clone());
      return copy;
    };
    if (type === 'COMPONENT') {
      result.componentPropertyDefinitions = {};
      result.createInstance = () => {
        const instance = node('INSTANCE', result.name, figma.currentPage);
        instance.getMainComponentAsync = async () => result;
        const definitions = result.parent?.type === 'COMPONENT_SET' ? result.parent.componentPropertyDefinitions : result.componentPropertyDefinitions;
        instance.componentProperties = Object.fromEntries(Object.entries(definitions).map(([key, def]) => [key, { type: def.type, value: result.variantProperties?.[key] ?? def.defaultValue }]));
        instance.variantProperties = { ...result.variantProperties };
        instance.setProperties = props => {
          for (const [key, value] of Object.entries(props)) {
            instance.componentProperties[key].value = value;
            if (instance.componentProperties[key].type === 'VARIANT') instance.variantProperties[key] = value;
          }
        };
        instance.findAllWithCriteria = ({ types }) => {
          const found = [];
          function visit(n) { for (const child of n.children ?? []) { if (types.includes(child.type)) found.push(child); visit(child); } }
          visit(instance); return found;
        };
        return instance;
      };
    }
    parent?.appendChild(result);
    return result;
  }
  const root = node('DOCUMENT', 'Test file');
  const pluginData = new Map();
  root.getPluginData = key => pluginData.get(key) ?? '';
  root.setPluginData = (key, value) => pluginData.set(key, value);
  const page = node('PAGE', 'Page 1', root);
  const figma = {
    clientStorage: { async getAsync() {}, async setAsync() {} },
    root, currentPage: page, mixed: Symbol('mixed'), editorType: 'figma', on() {},
    ui: { postMessage(message) { messages.push(message); }, resize() {}, reposition() {} }, showUI() {},
    async getNodeByIdAsync(id) { return nodes.get(id) ?? null; },
    async loadFontAsync(font) { fonts.push(font); },
    createPage: () => node('PAGE', 'Page', root),
    createComponent: () => node('COMPONENT', 'Component', figma.currentPage),
    async getStyleByIdAsync(id) { return styles.get(id) ?? null; },
    async getLocalTextStylesAsync() { return [...styles.values()]; },
    createTextStyle() {
      const id = `style:${nextId++}`;
      const style = { id, type: 'TEXT', name: '', fontName: { family: 'Inter', style: 'Regular' }, fontSize: 12, textWrapStyle: 'AUTO',
        remove() { styles.delete(id); } };
      styles.set(id, style);
      return style;
    },
    variables: {
      async getLocalVariableCollectionsAsync() { return [...collections.values()]; },
      async getLocalVariablesAsync() { return [...variables.values()]; },
      async getVariableByIdAsync(id) { return variables.get(id) ?? null; },
      async getVariableCollectionByIdAsync(id) { return collections.get(id) ?? null; },
      createVariableCollection(name) {
        const id = `collection:${nextId++}`;
        const result = { id, name, defaultModeId: 'mode:1', modes: [{ modeId: 'mode:1', name: 'Mode 1' }],
          remove() { collections.delete(id); } };
        collections.set(id, result);
        return result;
      },
      createVariable(name, collection, type) {
        const id = `variable:${nextId++}`;
        const result = { id, name, variableCollectionId: collection.id, resolvedType: type, valuesByMode: {}, remote: false,
          setValueForMode(modeId, value) { this.valuesByMode[modeId] = value; },
          remove() { variables.delete(id); } };
        variables.set(id, result);
        return result;
      },
      setBoundVariableForPaint(paint, field, variable) {
        return { ...paint, boundVariables: { [field]: { type: 'VARIABLE_ALIAS', id: variable.id } } };
      },
    },
    createFrame: () => node('FRAME', 'Frame', figma.currentPage),
    combineAsVariants(components, parent) {
      const set = node('COMPONENT_SET', 'Variants', parent);
      set.componentPropertyDefinitions = {};
      for (const component of components) {
        component.variantProperties = Object.fromEntries(component.name.split(', ').map(part => part.split('=')));
        for (const [key, value] of Object.entries(component.variantProperties)) {
          const def = set.componentPropertyDefinitions[key] ??= { type: 'VARIANT', defaultValue: value, variantOptions: [] };
          if (!def.variantOptions.includes(value)) def.variantOptions.push(value);
        }
        set.appendChild(component);
      }
      return set;
    },
    createImage() { return { hash: 'image-hash', async getSizeAsync() { return { width: 200, height: 100 }; } }; },
    createNodeFromSvg() {
      const frame = node('FRAME', 'SVG', figma.currentPage);
      node('VECTOR', 'Path', frame);
      frame.rescale = scale => { frame.width *= scale; frame.height *= scale; };
      return frame;
    },
    createRectangle: () => node('RECTANGLE', 'Rectangle', figma.currentPage),
    createEllipse: () => node('ELLIPSE', 'Ellipse', figma.currentPage),
    createText: () => node('TEXT', 'Text', figma.currentPage),
    commitUndo() { undoCount++; },
    async setCurrentPageAsync(page) { figma.currentPage = page; },
    viewport: { scrollAndZoomIntoView() {} },
    base64Encode: bytes => Buffer.from(bytes).toString('base64'),
    base64Decode: value => new Uint8Array(Buffer.from(value, 'base64')),
  };
  vm.runInNewContext(readFileSync(new URL('../plugin/code.js', import.meta.url), 'utf8'), {
    figma, __html__: '', console, Date: clock,
  });
  return { figma, page, root, node, nodes, fonts, variables, styles, collections, get undoCount() { return undoCount; },
    async getDocument() {
      messages.length = 0;
      await figma.ui.onmessage({ type: 'init' });
      return JSON.parse(JSON.stringify(messages.find(message => message.type === 'document').document));
    },
    async call(command, args = {}) {
      messages.length = 0;
      await figma.ui.onmessage({ type: 'command', id: 'test', command, args });
      return JSON.parse(JSON.stringify(messages.find(message => message.type === 'result')));
    },
  };
}
