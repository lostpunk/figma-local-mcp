import { mkdtemp, open, realpath, rename, rm, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { readAssetAccess } from './asset-access.mjs';

export const MAX_ASSET_BYTES = 8 * 1024 * 1024;
export const MAX_BATCH_BYTES = 64 * 1024 * 1024;
const id = z.string().min(1).max(200);
const name = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/).optional();
export const exportAssetsSchema = {
  outputDirectory: z.string().min(1).max(4096),
  items: z.array(z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('node'), nodeId: id, format: z.enum(['PNG', 'JPG', 'SVG', 'PDF']),
      scale: z.number().finite().positive().max(4).default(1), name }).strict(),
    z.object({ kind: z.literal('image'), imageHash: id, name }).strict(),
  ])).min(1).max(20),
};
const schema = z.object(exportAssetsSchema).strict();
const within = (root, path) => {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

export async function resolveExportDirectory(packageRoot, directory) {
  if (!isAbsolute(directory)) throw new Error('Export directory must be an absolute existing directory');
  const policy = await readAssetAccess(packageRoot);
  if (!policy.allowedExportRoots.length) throw new Error('Local export is disabled. Select an output directory with scripts/asset-access.mjs --allow-export PATH');
  const canonical = await realpath(directory);
  const root = policy.allowedExportRoots.find(root => within(root, canonical));
  if (!root) throw new Error('Export directory is outside the allowed export directories');
  if (await realpath(root) !== root) throw new Error('Allowed export directory changed; configure it again');
  const info = await stat(canonical);
  if (!info.isDirectory()) throw new Error('Export destination must be a directory');
  return { canonical, dev: info.dev, ino: info.ino };
}

function detectFormat(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return ['png', 'image/png'];
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return ['jpg', 'image/jpeg'];
  if (['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) return ['gif', 'image/gif'];
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return ['webp', 'image/webp'];
  if (bytes.subarray(0, 5).toString('ascii') === '%PDF-') return ['pdf', 'application/pdf'];
  const prefix = bytes.subarray(0, 4096).toString('utf8').replace(/^\uFEFF/, '').trimStart();
  if (/^(?:<\?xml[^>]*\?>\s*)?<svg(?=[\s/>])/.test(prefix)) return ['svg', 'image/svg+xml'];
  throw new Error('Unsupported exported file signature');
}

export function decodeExport(result, source) {
  if (typeof result?.dataBase64 !== 'string' || !result.dataBase64.length || result.dataBase64.length > Math.ceil(MAX_ASSET_BYTES / 3) * 4)
    throw new Error('Invalid exported payload size');
  const bytes = Buffer.from(result.dataBase64, 'base64');
  if (!bytes.length || bytes.length > MAX_ASSET_BYTES || bytes.length !== result.byteLength || bytes.toString('base64') !== result.dataBase64)
    throw new Error('Invalid exported bytes');
  const [extension, mimeType] = detectFormat(bytes);
  if (source.kind === 'image' ? !['png', 'jpg', 'gif', 'webp'].includes(extension) : extension !== source.format.toLowerCase())
    throw new Error('Exported format does not match the requested source');
  if (result.scale !== undefined && (!Number.isFinite(result.scale) || result.scale <= 0 || result.scale > 4))
    throw new Error('Invalid exported scale');
  return { bytes, extension, mimeType };
}

// Only writes new files in a fresh batch directory. Paths from the plugin are never used.
export async function exportAssets({ packageRoot, args, request }) {
  const { outputDirectory, items } = schema.parse(args);
  const destination = await resolveExportDirectory(packageRoot, outputDirectory);
  const directory = await mkdtemp(join(destination.canonical, 'figma-export-'));
  const created = await stat(directory);
  const manifestPath = join(directory, 'manifest.json');
  const manifest = { version: 1, status: 'running', entries: [], totalBytes: 0 };
  async function checkDirectory() {
    const current = await resolveExportDirectory(packageRoot, outputDirectory);
    if (current.canonical !== destination.canonical || current.dev !== destination.dev || current.ino !== destination.ino ||
        await realpath(directory) !== directory) throw new Error('Export directory changed during the batch');
    const info = await stat(directory);
    if (!info.isDirectory() || info.dev !== created.dev || info.ino !== created.ino) throw new Error('Export batch directory changed');
  }
  async function writeNew(path, bytes) {
    await checkDirectory();
    const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    try { await checkDirectory(); await file.writeFile(bytes); }
    finally { await file.close(); }
  }
  async function saveManifest() {
    const temp = join(directory, `manifest-${randomUUID()}.tmp`);
    try {
      await writeNew(temp, Buffer.from(JSON.stringify(manifest, null, 2) + '\n'));
      await checkDirectory();
      await rename(temp, manifestPath);
    } finally { await rm(temp, { force: true }); }
  }
  let sourceSession;
  let stoppedReason;
  let manifestError = false;
  let phase = 'destination';
  try {
    await saveManifest();
    for (let index = 0; index < items.length; index++) {
      phase = 'destination';
      await checkDirectory();
      const { name, ...source } = items[index];
      phase = 'source';
      const result = await request({ source, ...(sourceSession ? { sourceSession } : {}) });
      if (typeof result?.sourceSession !== 'string' || !result.sourceSession.length || result.sourceSession.length > 200 ||
          (sourceSession && result.sourceSession !== sourceSession)) throw new Error('EXPORT_SOURCE_CHANGED');
      sourceSession = result.sourceSession;
      const entry = { index, source };
      if (result.error) {
        // Do not persist arbitrary error strings or design text received from the plugin.
        const codes = ['IMAGE_NOT_FOUND', 'IMAGE_BYTES_UNAVAILABLE', 'NODE_NOT_FOUND', 'SCENE_EXPORT_REQUIRED',
          'NO_VISIBLE_BOUNDS', 'NODE_EXPORT_FAILED', 'ASSET_SIZE_LIMIT'];
        entry.status = 'failed'; entry.error = codes.includes(result.error) ? result.error : 'ASSET_EXPORT_FAILED';
      } else {
        let asset;
        try { asset = decodeExport(result, source); }
        catch { entry.status = 'failed'; entry.error = 'INVALID_ASSET_PAYLOAD'; }
        if (asset) {
          if (manifest.totalBytes + asset.bytes.length > MAX_BATCH_BYTES) {
            stoppedReason = 'BATCH_SIZE_LIMIT'; break;
          }
          const filename = `${String(index + 1).padStart(3, '0')}-${name ?? 'asset'}.${asset.extension}`;
          phase = 'destination';
          await writeNew(join(directory, filename), asset.bytes);
          Object.assign(entry, { status: 'saved', filename, mimeType: asset.mimeType, bytes: asset.bytes.length,
            sha256: createHash('sha256').update(asset.bytes).digest('hex'), ...(result.scale === undefined ? {} : { scale: result.scale }) });
          manifest.totalBytes += asset.bytes.length;
        }
      }
      manifest.entries.push(entry);
      phase = 'destination';
      await saveManifest();
    }
  } catch (error) {
    // A transport/path/policy failure ends the batch; do not retry an uncertain read automatically.
    stoppedReason = error.message?.startsWith('EXPORT_SOURCE_CHANGED') ? 'SOURCE_CHANGED'
      : phase === 'source' ? 'SOURCE_UNAVAILABLE' : 'DESTINATION_UNAVAILABLE';
  }
  manifest.status = stoppedReason || manifest.entries.some(entry => entry.status === 'failed') ? 'partial' : 'completed';
  if (stoppedReason) manifest.stoppedReason = stoppedReason;
  manifest.unprocessedIndices = items.map((_, index) => index).slice(manifest.entries.length);
  try { await saveManifest(); } catch { manifestError = true; }
  return { ...manifest, directory, manifestPath, manifestError,
    entries: manifest.entries.map(entry => ({ ...entry, ...(entry.filename ? { path: join(directory, entry.filename) } : {}) })) };
}
