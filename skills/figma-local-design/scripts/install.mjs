import { readFile, writeFile, mkdir, mkdtemp, rename, rm, lstat, cp, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';

const maxDownload = 8 * 1024 * 1024;
const marker = '.skill-install.json';
export async function downloadPayload(url, fetcher = fetch) {
  const signal = AbortSignal.timeout(30000);
  for (let redirects = 0; redirects <= 3; redirects++) {
    const address = new URL(url);
    if (address.protocol !== 'https:' || address.username || address.password) throw new Error('Use an HTTPS release URL without credentials');
    const response = await fetcher(address.href, { redirect: 'manual', signal });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location) throw new Error('Release redirect has no location');
      url = new URL(location, address).href;
      continue;
    }
    if (!response.ok || !response.body) throw new Error(`Release download failed: HTTP ${response.status}`);
    const chunks = []; let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > maxDownload) throw new Error('Release exceeds 8 MiB');
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  throw new Error('Too many release redirects');
}

export function validatePayload(buffer, sha256) {
  if (!/^[a-f0-9]{64}$/i.test(sha256 ?? '')) throw new Error('A release SHA256 is required');
  if (buffer.length > maxDownload) throw new Error('Release exceeds 8 MiB');
  if (createHash('sha256').update(buffer).digest('hex') !== sha256.toLowerCase()) throw new Error('Release SHA256 mismatch; nothing was installed');
  const payload = JSON.parse(gunzipSync(buffer, { maxOutputLength: 32 * 1024 * 1024 }).toString('utf8'));
  if (payload?.format !== 'figma-local-runtime-v1' || !/^\d+\.\d+\.\d+$/.test(payload.version) || !Array.isArray(payload.files) || payload.files.length > 300) throw new Error('Invalid release payload');
  const paths = new Set(); let total = 0;
  const files = payload.files.map(file => {
    const path = file.path;
    if (typeof path !== 'string' || !/^[a-zA-Z0-9_.\/-]+$/.test(path) || path.split('/').some(p => !p || p === '.' || p === '..' || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(p)) || /^(generated|skills)\//i.test(path)) throw new Error('Unsafe release path');
    if (paths.has(path.toLowerCase())) throw new Error('Duplicate release path');
    paths.add(path.toLowerCase());
    if (typeof file.data !== 'string') throw new Error('Invalid release file');
    const data = Buffer.from(file.data, 'base64');
    if (data.toString('base64') !== file.data) throw new Error('Invalid release file encoding');
    total += data.length;
    if (total > 24 * 1024 * 1024) throw new Error('Unpacked release exceeds 24 MiB');
    return { path, data };
  });
  for (const required of ['package.json', 'runtime/server.mjs', 'plugin/manifest.json', 'plugin/code.js', 'plugin/ui.html', 'scripts/setup.mjs', 'scripts/local-plugin.mjs', 'src/pairing.mjs']) {
    if (!files.some(f => f.path === required)) throw new Error('Incomplete release: ' + required);
  }
  const pkg = JSON.parse(files.find(f => f.path === 'package.json').data.toString());
  if (pkg.name !== 'figma-local-mcp' || pkg.version !== payload.version) throw new Error('Unexpected package identity');
  return { version: payload.version, files };
}

async function exists(path) { try { await lstat(path); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }
async function validPackage(root) {
  try { await access(join(root, 'runtime/server.mjs')); await access(join(root, 'scripts/setup.mjs')); return true; } catch { return false; }
}

export async function installPayload({ target, skillRoot, buffer, sha256, update = false }) {
  const payload = validatePayload(buffer, sha256); // Validate every path before writing anything.
  const present = await exists(target);
  if (present) {
    if ((await lstat(target)).isSymbolicLink()) throw new Error('Installation target is a symlink');
    let previous;
    try { previous = JSON.parse(await readFile(join(target, marker), 'utf8')); } catch {}
    if (previous?.format !== 'figma-local-install-v1') throw new Error('Target already exists and is not a managed installation; use --package-root for an existing checkout');
    if (previous.sha256 === sha256.toLowerCase() && await validPackage(target)) return { root: target, reused: true };
    if (!update) throw new Error('Another release is installed. Use --update to replace it with a backup');
  }
  await mkdir(dirname(target), { recursive: true });
  const stage = await mkdtemp(join(dirname(target), '.figma-install-'));
  let backup;
  try {
    for (const file of payload.files) {
      const path = join(stage, file.path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, file.data, { flag: 'wx' });
    }
    await cp(skillRoot, join(stage, 'skills/figma-local-design'), { recursive: true,
      filter: source => !['installation.json'].includes(source.split(/[\\/]/).at(-1)) });
    if (present && await exists(join(target, 'generated'))) await cp(join(target, 'generated'), join(stage, 'generated'), { recursive: true });
    await writeFile(join(stage, marker), JSON.stringify({ format: 'figma-local-install-v1', version: payload.version, sha256: sha256.toLowerCase() }) + '\n');
    if (present) { backup = target + '.backup-' + Date.now(); await rename(target, backup); }
    try { await rename(stage, target); }
    catch (error) { if (backup) await rename(backup, target); throw error; }
    return { root: target, reused: false, backup };
  } finally { await rm(stage, { recursive: true, force: true }); }
}

export async function main(argv = process.argv.slice(2)) {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Install Node.js 22 or newer first');
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (['--help', '--update', '--no-register', '--no-open'].includes(flag)) options[flag] = true;
    else if (['--target', '--package-root', '--url', '--sha256'].includes(flag) && argv[i + 1] && !argv[i + 1].startsWith('--')) options[flag] = argv[++i];
    else throw new Error('Unknown option or missing value: ' + flag);
  }
  if (options['--help']) {
    console.log('node scripts/install.mjs [--package-root PATH | --target PATH] [--url HTTPS_URL --sha256 HASH] [--update] [--no-register] [--no-open]\nDefault: install the embedded release, register figma_local in Codex, and reveal the Figma manifest. Requires Node.js 22+ and Codex CLI for registration.'); return;
  }
  if (!!options['--url'] !== !!options['--sha256']) throw new Error('Use --url and --sha256 together');
  if (options['--package-root'] && (options['--target'] || options['--url'])) throw new Error('Choose an existing package or a payload installation');
  const skillRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  let root;
  if (options['--package-root']) root = resolve(options['--package-root']);
  else if (!options['--target'] && !options['--url']) {
    try {
      const locator = JSON.parse(await readFile(join(skillRoot, 'installation.json'), 'utf8'));
      if (typeof locator.packageRoot === 'string' && await validPackage(locator.packageRoot)) root = resolve(locator.packageRoot);
    } catch {}
  }
  if (root && !await validPackage(root)) throw new Error('Existing package is incomplete: ' + root);
  // A development checkout is reused without overwriting its sources. Managed installs can be updated.
  if (!root || (options['--update'] && await exists(join(root, marker)))) {
    const release = JSON.parse(await readFile(join(skillRoot, 'assets/runtime-release.json'), 'utf8'));
    const buffer = options['--url'] ? await downloadPayload(options['--url']) : await readFile(join(skillRoot, 'assets/runtime-payload.json.gz'));
    const target = root ?? resolve(options['--target'] ?? join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'figma-local-mcp'));
    const installed = await installPayload({ target, skillRoot, buffer, sha256: options['--sha256'] ?? release.sha256, update: !!options['--update'] });
    root = installed.root;
    if (installed.backup) console.log('Previous installation backed up to: ' + installed.backup);
  }
  const result = spawnSync(process.execPath, [join(root, 'scripts/setup.mjs'), ...(options['--no-register'] ? [] : ['--register-mcp'])], { encoding: 'utf8', windowsHide: true });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.error || result.status !== 0) throw new Error(result.stderr || result.error?.message || 'MCP setup failed');
  await writeFile(join(skillRoot, 'installation.json'), JSON.stringify({ packageRoot: root }, null, 2) + '\n');
  const manifest = join(root, 'generated/figma-plugin/manifest.json');
  if (!options['--no-open']) {
    const command = process.platform === 'darwin' ? ['open', '-R', manifest] : process.platform === 'win32' ? ['explorer.exe', '/select,', manifest] : ['xdg-open', dirname(manifest)];
    const opened = spawnSync(command[0], command.slice(1), { windowsHide: true, stdio: 'ignore' });
    if (opened.error || opened.status !== 0) console.log('Open the manifest folder manually: ' + dirname(manifest));
  }
  console.log('One-time Figma step: Plugins > Development > Import plugin from manifest, then run Figma Local MCP Auto. No pairing code is needed.');
  return { root, manifest };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
