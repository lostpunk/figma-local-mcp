import { typographyKeys, DesignEdit, resolveDesignEdit, validateColorEdit, validateStyleEdit, validateDesignTarget } from './design-review';
import { isLayoutEdit, layoutProperties, predictLayout, layoutDescendants } from './layout-preview';
import { textHeightProposal, textSiblingState } from './text-fit';

// Property previews stay in this plugin session. No document/pluginData writes.
type Props = Record<string, any>;
type Change = { id: string; nodeId: string; property: string; before: any; after: any };
type Target = { nodeId: string; snapshot: string; changes: Change[]; layout?: any; design?: DesignEdit[] };
type Plan = { expiresAt: number; targets: Target[] };
const TTL = 5 * 60 * 1000;
const plans = new Map<string, Plan>();
const session = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
let sequence = 0;
const metadata = new Set(['name', 'opacity', 'visible', 'locked']);
const shapeProps = new Set([...metadata, 'x', 'y', 'width', 'height', 'fill', 'stroke', 'strokeWeight', 'cornerRadius']);
const geometry = new Set(['x', 'y', 'width', 'height']);
const radii = ['topLeftRadius', 'topRightRadius', 'bottomLeftRadius', 'bottomRightRadius'];
const stateKeys = ['name', 'x', 'y', 'width', 'height', 'rotation', 'relativeTransform', 'opacity', 'visible', 'locked', 'isMask',
  'resolvedVariableModes', 'fills', 'strokes', 'strokeWeight', 'strokeTopWeight', 'strokeBottomWeight', 'strokeLeftWeight', 'strokeRightWeight',
  'cornerRadius', ...radii, 'cornerSmoothing', 'effects', 'constraints',
  'boundVariables', 'explicitVariableModes', 'fillStyleId', 'strokeStyleId', 'effectStyleId',
  ...typographyKeys, 'characters', 'fontName', 'fontSize', 'textStyleId', 'textAutoResize', 'textAlignVertical', 'textAlignHorizontal',
  'lineHeight', 'letterSpacing', 'paragraphSpacing', 'paragraphIndent', 'listSpacing', 'textCase', 'textDecoration',
  'textTruncation', 'maxLines', 'hasMissingFont', 'absoluteRenderBounds', 'layoutMode',
  'primaryAxisSizingMode', 'counterAxisSizingMode', 'layoutSizingHorizontal', 'layoutSizingVertical',
  'layoutWrap', 'layoutPositioning', 'layoutGrow', 'layoutAlign', 'primaryAxisAlignItems', 'counterAxisAlignItems',
  'strokesIncludedInLayout', 'minWidth', 'maxWidth', 'minHeight', 'maxHeight', 'itemSpacing', 'paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight'];
const stateFieldIndexes = new Map([...new Set(['id', 'type', 'parentId', ...stateKeys, 'childIds'])].map((key, index) => [key, index]));

function copy(value: any): any {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value, (_key, v) => typeof v === 'symbol' ? { mixed: true } : v));
}
function stable(value: any): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
function state(node: any): Props {
  const result: Props = { id: node.id, type: node.type, parentId: node.parent?.id ?? null };
  for (const key of stateKeys) if (key in node) result[key] = copy(node[key]);
  if ('children' in node) result.childIds = node.children.map((child: BaseNode) => child.id);
  return result;
}
function compactState(node: any) {
  // Plans never leave this plugin session. Encode repeated keys, not values: every
  // captured field, nested value and absent-vs-null distinction still participates.
  return Object.entries(state(node)).map(([key, value]) => {
    const index = stateFieldIndexes.get(key);
    if (index === undefined) throw new Error(`Missing snapshot field: ${key}`);
    return [index, value];
  });
}
function snapshot(node: any, props: Props = {}, nodeState?: Props): string {
  if (node.removed) throw new Error(`Node removed: ${node.id}. Preview again.`);
  const ancestors: Props[] = [];
  let parent = node.parent;
  while (parent) {
    if (ancestors.length >= 64) throw new Error('Layer hierarchy is too deep for a change preview.');
    // Do not copy siblings or page contents into the plan.
    const context: Props = { id: parent.id, type: parent.type, parentId: parent.parent?.id ?? null };
    for (const key of ['x', 'y', 'width', 'height', 'relativeTransform', 'layoutMode', 'visible', 'locked', 'opacity', 'isMask', 'overflowDirection', 'clipsContent'])
      if (key in parent) context[key] = copy(parent[key]);
    if ('children' in parent) context.maskIds = parent.children.filter((child: any) => child.isMask).map((child: BaseNode) => child.id);
    ancestors.push(context);
    parent = parent.parent;
  }
  if (!ancestors.some(p => p.type === 'PAGE')) throw new Error('Layer must be attached to a page.');
  const value = stable({ node: nodeState ?? state(node), ancestors,
    descendants: isLayoutEdit(node, props) ? layoutDescendants(node).map(compactState) : undefined,
    siblings: node.type === 'TEXT' && 'height' in props ? textSiblingState(node) : undefined });
  if (value.length > 32000) throw new Error('Layer state is too large for a change preview.');
  return value;
}
export function validatePreviewProperties(node: any, props: Props) {
  if (!['RECTANGLE', 'ELLIPSE', 'FRAME', 'TEXT'].includes(node.type)) throw new Error(`Change previews do not support ${node.type}.`);
  const shape = node.type === 'RECTANGLE' || node.type === 'ELLIPSE';
  if ('strokeWeight' in props && typeof node.strokeWeight !== 'number')
    throw new Error('Preview does not support replacing mixed individual stroke weights.');
  for (const [key, value] of Object.entries(props)) {
    if (!(shape ? shapeProps : node.type === 'TEXT' ? new Set([...metadata, 'height']) : new Set([...metadata, ...layoutProperties])).has(key) || (key === 'cornerRadius' && node.type !== 'RECTANGLE'))
      throw new Error(`Preview does not support ${key} on ${node.type}.`);
    if (key === 'name' ? typeof value !== 'string' || value.length > 500
      : key === 'visible' || key === 'locked' ? typeof value !== 'boolean'
      : key === 'fill' || key === 'stroke' ? value !== null && (typeof value !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(value))
      : typeof value !== 'number' || !Number.isFinite(value)
        || (key === 'opacity' && (value < 0 || value > 1))
        || (['width', 'height'].includes(key) && (value <= 0 || value > 100000))
        || (key === 'strokeWeight' && (value < 0 || value > 1000))
        || (key === 'cornerRadius' && (value < 0 || value > 100000))
        || ((key === 'itemSpacing' || key.startsWith('padding')) && (value < 0 || value > 1000))
        || (['x', 'y'].includes(key) && Math.abs(value) > 1000000)) throw new Error(`Invalid preview value for ${key}.`);
  }
  const layout = isLayoutEdit(node, props);
  if (layout) predictLayout(node, props);
  if (node.type === 'TEXT' && 'height' in props) textHeightProposal(node, props.height);
  const impactful = Object.keys(props).some(key => key !== 'name' && key !== 'locked');
  const sizingOnly = (layout && Object.keys(props).every(k => layoutProperties.has(k) || ['name', 'locked'].includes(k)))
    || (node.type === 'TEXT' && 'height' in props && Object.keys(props).every(k => ['height', 'name', 'locked'].includes(k)));
  if (sizingOnly && Object.keys(props).some(key => node.boundVariables?.[key]))
    throw new Error('Preview cannot replace a bound sizing property. Keep its variable.');
  if (impactful && !sizingOnly && (Object.keys(node.boundVariables ?? {}).length || node.fillStyleId || node.strokeStyleId || node.effectStyleId
    || [...(Array.isArray(node.fills) ? node.fills : []), ...(node.strokes ?? [])].some(p => Object.keys(p.boundVariables ?? {}).length)))
    throw new Error('Preview cannot change appearance or geometry of bound/styled layers. Keep their variables and styles.');
  for (let current = node; current && current.type !== 'DOCUMENT'; current = current.parent) {
    if (['INSTANCE', 'COMPONENT', 'COMPONENT_SET'].includes(current.type)) throw new Error('Preview does not support component or instance hierarchies.');
    if (impactful && (current.type === 'GROUP' || (current.layoutMode && current.layoutMode !== 'NONE' && !(layout && current === node))))
      throw new Error('Preview supports only name/locked inside groups or Auto Layout.');
  }
}
function paint(hex: string | null): any[] {
  return hex === null ? [] : [{ type: 'SOLID', color: {
    r: parseInt(hex.slice(1, 3), 16) / 255, g: parseInt(hex.slice(3, 5), 16) / 255, b: parseInt(hex.slice(5, 7), 16) / 255,
  }, opacity: 1, visible: true, blendMode: 'NORMAL' }];
}
function read(node: any, key: string): any {
  if (key === 'fillVariableId' || key === 'strokeVariableId') return node[key === 'fillVariableId' ? 'fills' : 'strokes'][0]?.boundVariables?.color?.id ?? null;
  return copy(node[key === 'fill' ? 'fills' : key === 'stroke' ? 'strokes' : key]);
}
function equivalent(a: any, b: any): boolean {
  // Figma stores numeric values as floats; do not swallow pixel-sized edits at large coordinates.
  if (typeof a === 'number' && typeof b === 'number') return a === b || Math.fround(a) === Math.fround(b);
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => equivalent(v, b[i]));
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const normalize = (value: any) => value.type === 'SOLID'
      ? { opacity: 1, visible: true, blendMode: 'NORMAL', boundVariables: {}, ...value } : value;
    a = normalize(a); b = normalize(b);
    return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(k => k in b && equivalent(a[k], b[k]));
  }
  return a === b;
}
function write(node: any, props: Props) {
  if ('width' in props || 'height' in props) node.resize(props.width ?? node.width, props.height ?? node.height);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'width' || key === 'height' || key === 'locked') continue;
    node[key === 'fill' ? 'fills' : key === 'stroke' ? 'strokes' : key] = value;
  }
  if ('locked' in props) node.locked = props.locked;
}
function restore(node: any, props: Props, before: Props) {
  if (Object.keys(props).some(key => geometry.has(key))) {
    node.resize(before.width, before.height);
    node.relativeTransform = before.relativeTransform;
    node.x = before.x; node.y = before.y;
  }
  for (const key of Object.keys(props).reverse()) {
    if (geometry.has(key)) continue;
    if (key === 'cornerRadius' && typeof before.cornerRadius !== 'number') {
      for (const radius of radii) node[radius] = before[radius];
    } else node[key === 'fill' ? 'fills' : key === 'stroke' ? 'strokes' : key] = before[key === 'fill' ? 'fills' : key === 'stroke' ? 'strokes' : key];
  }
}
function prune() {
  for (const [id, plan] of plans) if (plan.expiresAt <= Date.now()) plans.delete(id);
}
export async function previewChanges(args: Props, getNode: (id: string) => Promise<BaseNode>) {
  if (!Array.isArray(args.changes) || !args.changes.length || args.changes.length > 50) throw new Error('Provide 1–50 layers.');
  const ids = new Set<string>();
  let count = 0;
  for (const entry of args.changes) {
    if (!entry || typeof entry.nodeId !== 'string' || ids.has(entry.nodeId) || !entry.props || Array.isArray(entry.props)
      || typeof entry.props !== 'object' || !Object.keys(entry.props).length) throw new Error('Provide unique layers with nonempty properties.');
    ids.add(entry.nodeId); count += Object.keys(entry.props).length;
  }
  if (count > 200) throw new Error('At most 200 properties per preview.');
  const nodes: any[] = [];
  for (const entry of args.changes) nodes.push(await getNode(entry.nodeId));
  return createChangePreview(nodes.map((node, index) => ({ node, props: args.changes[index].props })));
}
// Synchronous planning also lets audit fixes compute coordinates and capture their basis without an async gap.
export function createChangePreview(entries: { node: any; props: Props; design?: DesignEdit[] }[]) {
  const ids = new Set(entries.map(entry => entry.node.id));
  if (!entries.length || entries.length > 50 || ids.size !== entries.length
    || entries.reduce((count, entry) => count + Object.keys(entry.props).length, 0) > 200)
    throw new Error('Preview requires 1–50 unique layers and at most 200 properties.');
  // Capture all states only after the final async lookup.
  const targets: Target[] = [];
  let changeNumber = 0;
  for (const { node, props, design } of entries) {
    if (design) validateDesignTarget(node, design); else validatePreviewProperties(node, props);
    for (let parent = node.parent; parent; parent = parent.parent)
      if (ids.has(parent.id)) throw new Error('Preview parent and descendant layers in separate plans.');
    const changes: Change[] = [];
    for (const [property, value] of Object.entries(props)) {
      const before = read(node, property);
      const after = property === 'fill' || property === 'stroke' ? paint(value as string | null) : value;
      if (!equivalent(before, after)) changes.push({ id: `c${++changeNumber}`, nodeId: node.id, property, before, after });
    }
    const effectiveProps = Object.fromEntries(changes.map(change => [change.property, change.after]));
    const prediction = isLayoutEdit(node, effectiveProps) ? predictLayout(node, effectiveProps) : null;
    const layout = prediction ? { nodeId: node.id, frame: prediction.frame, children: prediction.children } : undefined;
    targets.push({ nodeId: node.id, snapshot: snapshot(node, effectiveProps), changes, layout, design });
  }
  if (stable(targets).length > 256000) throw new Error('Preview state is too large; use fewer layers.');
  prune();
  while (plans.size >= 10) plans.delete(plans.keys().next().value!);
  const planId = `${session}-${++sequence}`;
  const expiresAt = Date.now() + TTL;
  plans.set(planId, { expiresAt, targets });
  return { planId, expiresAt, singleUse: true, previewType: 'properties', changes: targets.flatMap(target => target.changes),
    layoutEffects: targets.filter(t => t.layout).map(t => t.layout),
    atomicNodeIds: targets.filter(t => t.layout).map(t => t.nodeId) };
}
export async function applyChanges(args: Props, getNode: (id: string) => Promise<BaseNode>) {
  prune();
  const plan = plans.get(args.planId);
  if (!plan) throw new Error('Unknown, expired or consumed plan. Preview again in this plugin session.');
  if (!Array.isArray(args.changeIds) || !args.changeIds.length || args.changeIds.length > 200
    || new Set(args.changeIds).size !== args.changeIds.length) throw new Error('Select 1–200 unique change IDs.');
  const selection = new Set(args.changeIds);
  const allChanges = plan.targets.flatMap(target => target.changes);
  if (args.changeIds.some((id: any) => !allChanges.some(change => change.id === id))) throw new Error('Unknown change ID. Use IDs from this plan.');
  const pending: { node: any; target: Target; props: Props; before: Props; resources?: any[]; afterSnapshot?: string; designStable?: boolean }[] = [];
  for (const target of plan.targets) {
    const chosen = target.changes.filter(change => selection.has(change.id));
    if (chosen.length && target.layout && chosen.length !== target.changes.length)
      throw new Error('Select all changes for a layout frame, or preview the smaller property set again.');
    if (chosen.length) pending.push({ node: await getNode(target.nodeId), target,
      props: Object.fromEntries(chosen.map(change => [change.property, change.after])), before: {} });
  }
  for (const item of pending) if (item.target.design) {
    item.resources = [];
    for (const edit of item.target.design) {
      const resource = await resolveDesignEdit(item.node, edit);
      item.resources.push(resource);
      if (edit.property === 'textStyleId') await figma.loadFontAsync((resource as TextStyle).fontName);
    }
  }
  for (const item of pending) if (item.node.type === 'TEXT' && 'height' in item.props) {
    const fonts = item.node.characters.length ? item.node.getRangeAllFontNames(0, item.node.characters.length) : [item.node.fontName];
    for (const font of fonts) await figma.loadFontAsync(font);
  }
  // Resolve fonts/resources before preflight. Style binding is asynchronous and is checked again per target and after writing.
  if (plan.expiresAt <= Date.now()) { plans.delete(args.planId); throw new Error('Plan expired during lookup. Preview again.'); }
  for (const item of pending) {
    if (snapshot(item.node, Object.fromEntries(item.target.changes.map(c => [c.property, c.after]))) !== item.target.snapshot) throw new Error(`Layer ${item.target.nodeId} or its context changed. Preview again; no changes applied.`);
    if (item.target.design) for (const [index, edit] of item.target.design.entries())
      if (edit.property !== 'textStyleId') validateColorEdit(item.node, edit, item.resources![index]);
      else validateStyleEdit(item.node, edit, item.resources![index]);
    item.before = state(item.node);
  }
  plans.delete(args.planId);
  figma.commitUndo();
  const touched: typeof pending = [];
  try {
    for (const item of pending) {
      const contextProps = Object.fromEntries(item.target.changes.map(c => [c.property, c.after]));
      if (item.target.design && snapshot(item.node, contextProps) !== item.target.snapshot) throw new Error('Layer changed during application; remaining layers were not written.');
      touched.push(item);
      if (item.target.design) {
        for (const [index, edit] of item.target.design.entries()) {
          if (!(edit.property in item.props)) continue;
          if (edit.property === 'textStyleId') validateStyleEdit(item.node, edit, item.resources![index]);
          else validateColorEdit(item.node, edit, item.resources![index]);
          const before = state(item.node), beforeSnapshot = snapshot(item.node, contextProps);
          const field = edit.property === 'textStyleId' ? 'textStyleId' : edit.property === 'fillVariableId' ? 'fills' : 'strokes';
          const expected = edit.property === 'textStyleId' ? edit.resourceId
            : [figma.variables.setBoundVariableForPaint(item.node[field][0], 'color', item.resources![index])];
          // An interrupted/unverified setter must not make concurrent edits a rollback baseline.
          item.designStable = false;
          item.afterSnapshot = undefined;
          if (edit.property === 'textStyleId') await item.node.setTextStyleIdAsync(edit.resourceId);
          else item.node[field] = expected;
          // Exempt only this write's field, not fields written earlier in this batch.
          const changedKeys = new Set(['boundVariables', 'resolvedVariableModes', field]);
          const after = state(item.node);
          if (!Object.keys(before).every(key => changedKeys.has(key) || stable(before[key]) === stable(after[key]))
              || snapshot(item.node, contextProps, before) !== beforeSnapshot)
            throw new Error('Binding changed other layer properties or context. Inspect the layer before continuing.');
          if (!equivalent(after[field], expected)) throw new Error(`Figma did not retain planned ${edit.property} on ${item.node.id}.`);
          item.afterSnapshot = snapshot(item.node, contextProps);
          item.designStable = true;
        }
      } else write(item.node, item.props);
    }
    for (const item of pending) if (item.target.design) {
      if (snapshot(item.node, item.props) !== item.afterSnapshot) throw new Error('Layer changed while applying another binding. Inspect affected layers.');
      for (const [index, edit] of item.target.design.entries()) if (edit.property in item.props) {
        if (edit.property === 'textStyleId') validateStyleEdit(item.node, edit, item.resources![index]);
        else validateColorEdit(item.node, edit, item.resources![index]);
      }
    }
    for (const item of pending) for (const [key, expected] of Object.entries(item.props))
      if (!equivalent(read(item.node, key), expected)) throw new Error(`Figma did not retain planned ${key} on ${item.node.id}.`);
    for (const item of pending) if (item.target.layout) {
      const children = new Map(item.node.children.map((n: any) => [n.id, n]));
      for (const effect of item.target.layout.children) for (const [key, expected] of Object.entries(effect.after))
        if (!equivalent((children.get(effect.nodeId) as any)?.[key], expected))
          throw new Error(`Figma layout differs from the preview on ${effect.nodeId}.`);
    }
    for (const item of pending) for (const key of ['x', 'y', 'width', 'height', 'rotation'])
      if (!(key in item.props) && !equivalent(item.node[key], item.before[key]))
        throw new Error(`Figma changed unselected ${key} on ${item.node.id}.`);
  } catch (error) {
    let restored = true;
    for (const item of touched.reverse()) {
      try {
        if (item.target.design) {
          const contextProps = Object.fromEntries(item.target.changes.map(c => [c.property, c.after]));
          if (!item.designStable || !item.afterSnapshot || snapshot(item.node, contextProps) !== item.afterSnapshot) { restored = false; continue; }
          for (const edit of item.target.design) if (edit.property in item.props) {
            if (edit.property === 'textStyleId') await item.node.setTextStyleIdAsync(item.before.textStyleId);
            else { const field = edit.property === 'fillVariableId' ? 'fills' : 'strokes'; item.node[field] = item.before[field]; }
          }
        } else restore(item.node, item.props, item.before);
      } catch { restored = false; }
    }
    for (const item of touched) {
      try { if (snapshot(item.node, Object.fromEntries(item.target.changes.map(c => [c.property, c.after]))) !== item.target.snapshot) restored = false; } catch { restored = false; }
    }
    figma.commitUndo();
    throw new Error(`${error instanceof Error ? error.message : String(error)} ${restored
      ? 'Original layer states restored.' : 'Rollback incomplete. Inspect affected layers and use Figma Undo if needed.'} Plan consumed; preview again.`);
  }
  figma.commitUndo();
  return { planId: args.planId, appliedChangeIds: args.changeIds, nodeIds: pending.map(item => item.node.id), layoutEffects: pending.filter(item => item.target.layout).map(item => item.target.layout), consumed: true };
}
