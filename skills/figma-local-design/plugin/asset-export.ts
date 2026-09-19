const MAX_ASSET_BYTES = 8 * 1024 * 1024;
// Not a credential: it prevents one batch from silently mixing different plugin/file sessions.
const sourceSession = `export-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
type Args = Record<string, any>;

export async function exportAsset(args: Args, getNode: (id: string) => Promise<BaseNode>) {
  if (args.sourceSession !== undefined && args.sourceSession !== sourceSession)
    throw new Error('EXPORT_SOURCE_CHANGED: The plugin session changed; start a fresh export for the intended file');
  const source = args.source;
  if (!source || !['node', 'image'].includes(source.kind)) throw new Error('Invalid export source');
  let bytes: Uint8Array;
  let scale: number | undefined;
  if (source.kind === 'image') {
    if (typeof source.imageHash !== 'string' || !source.imageHash.length || source.imageHash.length > 200)
      throw new Error('Invalid imageHash');
    try {
      const image = figma.getImageByHash(source.imageHash);
      if (!image) return { sourceSession, error: 'IMAGE_NOT_FOUND' };
      bytes = await image.getBytesAsync();
    }
    catch { return { sourceSession, error: 'IMAGE_BYTES_UNAVAILABLE' }; }
  } else {
    if (typeof source.nodeId !== 'string' || !source.nodeId.length || source.nodeId.length > 200 ||
        !['PNG', 'JPG', 'SVG', 'PDF'].includes(source.format)) throw new Error('Invalid node export source');
    const requestedScale = source.scale ?? 1;
    if (!Number.isFinite(requestedScale) || requestedScale <= 0 || requestedScale > 4) throw new Error('Invalid export scale');
    let node: BaseNode;
    try { node = await getNode(source.nodeId); }
    catch { return { sourceSession, error: 'NODE_NOT_FOUND' }; }
    if (node.type === 'PAGE' || node.type === 'DOCUMENT' || !('exportAsync' in node))
      return { sourceSession, error: 'SCENE_EXPORT_REQUIRED' };
    try {
      if (source.format === 'PNG' || source.format === 'JPG') {
        const bounds = ('absoluteRenderBounds' in node ? node.absoluteRenderBounds : null) ?? node.absoluteBoundingBox;
        if (!bounds || bounds.width <= 0 || bounds.height <= 0) return { sourceSession, error: 'NO_VISIBLE_BOUNDS' };
        scale = Math.min(requestedScale, 4096 / Math.max(bounds.width, bounds.height));
        bytes = await node.exportAsync({ format: source.format, contentsOnly: true, constraint: { type: 'SCALE', value: scale } });
      } else if (source.format === 'SVG') {
        bytes = await node.exportAsync({ format: 'SVG', contentsOnly: true, svgOutlineText: true, svgIdAttribute: false });
      } else bytes = await node.exportAsync({ format: 'PDF', contentsOnly: true });
    } catch { return { sourceSession, error: 'NODE_EXPORT_FAILED' }; }
  }
  if (!bytes.length || bytes.length > MAX_ASSET_BYTES) return { sourceSession, error: 'ASSET_SIZE_LIMIT' };
  return { sourceSession, dataBase64: figma.base64Encode(bytes), byteLength: bytes.length, ...(scale === undefined ? {} : { scale }) };
}
