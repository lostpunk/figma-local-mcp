import { resourceRevision } from './resource-revision';
import { jsonBytes } from './response-size';
import limits from '../src/response-limits.json';

type Args = Record<string, any>;
// Preview revisions expire with the plugin/file session; they are change detectors, not authorization tokens.
const themeSession = `${Date.now()}-${Math.random()}`;
function failureMessage(error: unknown, fallback: string): string {
  return error && typeof error === 'object' && 'message' in error && typeof error.message === 'string'
    ? error.message.slice(0, 500) : fallback;
}
export const libraryThemeCommands = new Set(['get_library_variables', 'import_library_asset', 'get_variable_modes', 'set_variable_mode', 'create_variable_mode']);
function id(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.length || value.length > 200) throw new Error('Expected an ID or key of 1–200 characters');
}
function modeSummary(collection: VariableCollection) {
  return { id: collection.id, key: collection.key, name: collection.name.slice(0, 500), remote: collection.remote,
    defaultModeId: collection.defaultModeId, modes: collection.modes.map(mode => ({ modeId: mode.modeId, name: mode.name.slice(0, 500) })) };
}
async function getCollection(collectionId: string) {
  id(collectionId);
  const local = await figma.variables.getLocalVariableCollectionsAsync();
  const collection = local.find(item => item.id === collectionId) ?? await figma.variables.getVariableCollectionByIdAsync(collectionId);
  if (!collection) throw new Error('Variable collection not found; read local design system or import a library variable first');
  return collection;
}
function preview(args: Args, revision: string) {
  if (args.dryRun !== undefined && typeof args.dryRun !== 'boolean') throw new Error('Invalid dryRun');
  if (args.dryRun !== false) return true;
  if (!args.revision || args.revision !== revision) throw new Error('THEME_CHANGED: Preview again and pass its revision before applying');
  return false;
}
async function libraries(args: Args) {
  const offset = args.offset ?? 0, limit = args.limit ?? 100, maxBytes = args.maxResponseBytes ?? limits.defaultReadBytes;
  if (!Number.isInteger(offset) || offset < 0 || offset > 1000000 || !Number.isInteger(limit) || limit < 1 || limit > 200 ||
    !Number.isInteger(maxBytes) || maxBytes < limits.minReadBytes || maxBytes > limits.maxReadBytes) throw new Error('Invalid library read bounds');
  if (args.collectionKey !== undefined) id(args.collectionKey);
  let entries: Args[];
  try {
    entries = args.collectionKey === undefined
      ? (await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync()).map(c => ({ key: c.key, name: c.name, libraryName: c.libraryName }))
      : (await figma.teamLibrary.getVariablesInLibraryCollectionAsync(args.collectionKey)).map(v => ({ key: v.key, name: v.name, resolvedType: v.resolvedType }));
  } catch (error) {
    // Preserve a bounded cause for local troubleshooting instead of hiding every
    // failure behind the same permission hint. Never forward URLs or long keys.
    const cause = failureMessage(error, 'Figma library API failed')
      .replace(/(?:https?|wss?):\/\/[^\s]+/gi, '[url]')
      .replace(/\b(?:token|authorization|password)\s*[:=]\s*\S+/gi, '[secret]')
      .replace(/[A-Za-z0-9+/=_-]{32,}/g, '[redacted]')
      .replace(/[\x00-\x1f\x7f]/g, ' ');
    throw new Error(`LIBRARY_ACCESS_FAILED: ${cause}. Check Figma access, connectivity, enabled libraries and the plugin manifest teamlibrary permission. If the permission was added recently, re-import the generated manifest. No assets were imported.`);
  }
  entries.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  const revision = resourceRevision([args.collectionKey ?? null, entries]);
  if ((offset > 0 && !args.revision) || (args.revision && args.revision !== revision))
    throw new Error('LIBRARIES_CHANGED: Restart at offset 0 without revision; continue with the returned revision');
  if (offset > entries.length) throw new Error('Library offset exceeds current list');
  const items: Args[] = [];
  let bytes = 0, next = offset;
  for (; next < entries.length && items.length < limit; next++) {
    const size = jsonBytes(entries[next]) + 1;
    if (bytes + size > maxBytes - 2048) break;
    items.push(entries[next]); bytes += size;
  }
  return { kind: args.collectionKey === undefined ? 'collections' : 'variables', collectionKey: args.collectionKey,
    revision, items, offset, total: entries.length, nextOffset: next < entries.length ? next : null,
    complete: next === entries.length, ...(next === offset && next < entries.length ? { blocked: true, reason: 'byte_limit',
      recovery: 'Increase maxResponseBytes; do not repeat identical bounds.' } : {}) };
}

export async function executeLibraryTheme(command: string, args: Args, getNode: (id: string) => Promise<BaseNode>): Promise<any> {
  if (command === 'get_library_variables') return libraries(args);
  if (command === 'import_library_asset') {
    id(args.key);
    let asset: ComponentNode | ComponentSetNode | Variable;
    try {
      if (args.kind === 'component') asset = await figma.importComponentByKeyAsync(args.key);
      else if (args.kind === 'componentSet') asset = await figma.importComponentSetByKeyAsync(args.key);
      else if (args.kind === 'variable') asset = await figma.variables.importVariableByKeyAsync(args.key);
      else throw new Error('Unsupported library asset kind');
    } catch (error) { throw new Error(`LIBRARY_IMPORT_FAILED: ${failureMessage(error, 'Figma import failed')}. Inspect the file before retrying an uncertain import; no local imitation was created.`); }
    figma.commitUndo();
    return { kind: args.kind, id: asset.id, key: asset.key, name: asset.name.slice(0, 500), remote: asset.remote,
      ...('variableCollectionId' in asset ? { collectionId: asset.variableCollectionId, resolvedType: asset.resolvedType } : { type: asset.type }),
      note: 'Imported reference only; no instance created and no layer bound. Inspect returned IDs before using them.' };
  }
  const collection = await getCollection(args.collectionId);
  if (command === 'create_variable_mode') {
    if (collection.remote || collection.isExtension) throw new Error('Modes can only be created on a local, non-extended collection');
    if (typeof args.name !== 'string' || !args.name.trim() || args.name.length > 100) throw new Error('Mode name must be 1–100 characters');
    const name = args.name.trim();
    if (collection.modes.some(mode => mode.name === name)) throw new Error('A mode with this name already exists; reuse its modeId');
    const sourceModeId = args.sourceModeId ?? collection.defaultModeId;
    if (!collection.modes.some(mode => mode.modeId === sourceModeId)) throw new Error('Source mode does not belong to this collection');
    if (collection.variableIds.length > 1000) throw new Error('Mode copy supports at most 1000 variables; use Figma for this collection');
    const variables = (await figma.variables.getLocalVariablesAsync()).filter(v => v.variableCollectionId === collection.id)
      .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const variableIds = new Set(variables.map(v => v.id));
    if (variables.length !== collection.variableIds.length || collection.variableIds.some(id => !variableIds.has(id)))
      throw new Error('Collection variables changed or are unavailable; preview again');
    const values = variables.map(variable => {
      const value = variable.valuesByMode[sourceModeId];
      if (value === undefined) throw new Error('Source mode contains an unavailable value; no mode created');
      return { id: variable.id, value };
    });
    if (jsonBytes(values) > 1024 * 1024) throw new Error('Source mode exceeds the 1 MiB copy budget');
    const revision = resourceRevision([themeSession, collection.id, collection.modes, name, sourceModeId, values]);
    const info = { collectionId: collection.id, name, sourceModeId, variableCount: values.length, revision,
      note: 'Copies source values and aliases; does not change the default mode or switch layers. Figma enforces plan limits on apply.' };
    if (preview(args, revision)) return { ...info, dryRun: true };
    let modeId: string | undefined;
    try {
      modeId = collection.addMode(name);
      for (let i = 0; i < variables.length; i++) variables[i].setValueForMode(modeId, values[i].value);
      figma.commitUndo();
      return { ...info, dryRun: false, modeId };
    } catch (error) {
      let cleanup = 'No new mode created.';
      if (modeId) {
        try { collection.removeMode(modeId); cleanup = 'New mode removed; original modes preserved.'; }
        catch { cleanup = `Cleanup incomplete for mode ${modeId}; inspect the collection before further edits.`; }
      }
      throw new Error(`MODE_CREATE_FAILED: ${failureMessage(error, 'Figma rejected the mode')}. ${cleanup}`);
    }
  }
  if (!['get_variable_modes', 'set_variable_mode'].includes(command)) throw new Error('Unknown library/theme command');
  const node = args.nodeId ? await getNode(args.nodeId) : undefined;
  if (node && !('explicitVariableModes' in node)) throw new Error('Node does not support variable modes');
  const target = node as (BaseNode & ExplicitVariableModesMixin & { resolvedVariableModes?: Record<string, string> }) | undefined;
  const state = target ? { nodeId: target.id, explicitModeId: target.explicitVariableModes[collection.id] ?? null,
    resolvedModeId: target.resolvedVariableModes?.[collection.id] ?? null } : undefined;
  if (command === 'get_variable_modes') return { collection: modeSummary(collection), node: state };
  if (!target || !state) throw new Error('set_variable_mode requires nodeId');
  if (args.modeId !== null && !collection.modes.some(mode => mode.modeId === args.modeId)) throw new Error('Mode does not belong to this collection; use null to clear the override');
  const revision = resourceRevision([themeSession, collection.id, collection.modes, state, args.modeId]);
  const info = { collectionId: collection.id, ...state, targetModeId: args.modeId, revision,
    note: 'Changes only this node override; descendants without their own override inherit it. Token definitions stay unchanged.' };
  if (preview(args, revision)) return { ...info, dryRun: true };
  if (state.explicitModeId === args.modeId) return { ...info, dryRun: false, changed: false };
  try {
    if (args.modeId === null) target.clearExplicitVariableModeForCollection(collection);
    else target.setExplicitVariableModeForCollection(collection, args.modeId);
    if ((target.explicitVariableModes[collection.id] ?? null) !== args.modeId) throw new Error('Figma did not retain the requested override');
    figma.commitUndo();
  } catch (error) {
    let restored = true;
    try {
      if (state.explicitModeId === null) target.clearExplicitVariableModeForCollection(collection);
      else target.setExplicitVariableModeForCollection(collection, state.explicitModeId);
    } catch { restored = false; }
    throw new Error(`MODE_SET_FAILED: ${failureMessage(error, 'Figma rejected the mode')}. ${restored ? 'Original override restored.' : 'Restore failed; inspect the node.'}`);
  }
  return { ...info, dryRun: false, changed: true, explicitModeId: target.explicitVariableModes[collection.id] ?? null,
    resolvedModeId: target.resolvedVariableModes?.[collection.id] ?? null };
}
