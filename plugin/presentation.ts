// UI preferences are local to the plugin installation, never document/plugin data.
const preferenceKey = 'figma-local-presentation-v1';
const sizes = { compact: { width: 300, height: 64 }, expanded: { width: 380, height: 640 } };
export const initialWindowSize = sizes.compact;

export function createPresentation() {
  let compact = true, revision = 0, initialized = false;
  let saves = Promise.resolve();
  const report = (error: string) => figma.ui.postMessage({ type: 'presentation-error', error });
  function apply(value: boolean) {
    const size = value ? sizes.compact : sizes.expanded;
    try { figma.ui.resize(size.width, size.height); }
    catch {
      figma.ui.postMessage({ type: 'presentation-state', compact });
      report('Не удалось изменить размер окна. Попробуйте ещё раз; соединение продолжает работать.');
      return false;
    }
    compact = value;
    figma.ui.postMessage({ type: 'presentation-state', compact });
    return true;
  }
  async function initialize() {
    if (initialized) return;
    initialized = true;
    const started = revision;
    try {
      const saved = await figma.clientStorage.getAsync(preferenceKey);
      if (revision !== started) return; // A click made while loading takes precedence.
      apply(saved?.version === 1 && typeof saved.compact === 'boolean' ? saved.compact : compact);
    } catch { report('Не удалось прочитать настройки окна. Выбранный режим доступен в этом запуске.'); }
  }
  function setMode(value: unknown) {
    if (typeof value !== 'boolean') return;
    revision++;
    if (!apply(value)) return;
    const preference = { version: 1, compact };
    saves = saves.then(() => figma.clientStorage.setAsync(preferenceKey, preference))
      .catch(() => report('Не удалось запомнить режим окна. Соединение продолжает работать.'));
  }
  function move(edge: unknown) {
    if (edge !== 'left' && edge !== 'right') return;
    try {
      const { bounds, zoom } = figma.viewport;
      if (![bounds.x, bounds.y, bounds.width, bounds.height, zoom].every(Number.isFinite) || zoom <= 0)
        throw new Error('Unavailable viewport');
      const size = compact ? sizes.compact : sizes.expanded;
      const inset = 12 / zoom;
      // This places the floating window near the canvas edge; it is not panel docking.
      const x = edge === 'left' ? bounds.x + inset : Math.max(bounds.x + inset, bounds.x + bounds.width - size.width / zoom - inset);
      figma.ui.reposition(x, bounds.y + inset);
    } catch { report('Не удалось переместить окно. Перетащите его за заголовок.'); }
  }
  return { initialize, setMode, move };
}
