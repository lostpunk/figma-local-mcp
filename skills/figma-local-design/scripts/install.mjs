import { access, cp, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';

const marker = '.skill-install.json';
const requiredEntries = ['package.json', 'runtime/server.mjs', 'plugin/manifest.json', 'plugin/code.js', 'plugin/ui.html', 'scripts/setup.mjs', 'scripts/local-plugin.mjs', 'src/pairing.mjs'];
const copiedEntries = ['package.json', 'runtime', 'plugin', 'scripts/setup.mjs', 'scripts/local-plugin.mjs', 'src'];

async function exists(path) {
  try { await lstat(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function validPackage(root) {
  try {
    for (const entry of requiredEntries) await access(join(root, entry));
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    return pkg.name === 'figma-local-mcp' && /^\d+\.\d+\.\d+$/.test(pkg.version);
  } catch { return false; }
}

async function assertInspectableSource(root) {
  if (!(await validPackage(root))) throw new Error('The embedded Figma runtime sources are incomplete. Reinstall this skill from a complete package.');
  for (const entry of copiedEntries) {
    if ((await lstat(join(root, entry))).isSymbolicLink()) throw new Error(`Embedded runtime entry is a symlink: ${entry}`);
  }
}

async function embeddedRoot(skillRoot) {
  for (const candidate of [skillRoot, resolve(skillRoot, '../..')]) {
    if (await validPackage(candidate)) return candidate;
  }
  throw new Error('No inspectable embedded runtime was found. The skill package must include runtime/, plugin/, src/ and setup scripts.');
}

export async function installEmbedded({ source, target, update = false }) {
  await assertInspectableSource(source);
  const pkg = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
  const present = await exists(target);
  if (present) {
    if ((await lstat(target)).isSymbolicLink()) throw new Error('Installation target is a symlink');
    let previous;
    try { previous = JSON.parse(await readFile(join(target, marker), 'utf8')); } catch {}
    const isLegacyInstallation = previous?.format === 'figma-local-install-v1';
    const isCurrentInstallation = previous?.format === 'figma-local-install-v2';
    if (!isLegacyInstallation && !isCurrentInstallation) throw new Error('Target already exists and is not a managed installation; use --package-root for an existing checkout');
    if (isCurrentInstallation && previous.version === pkg.version && (await validPackage(target))) return { root: target, reused: true };
    if (!update) throw new Error('Another release is installed. Use --update to replace it with a backup');
  }
  await mkdir(dirname(target), { recursive: true });
  const stage = await mkdtemp(join(dirname(target), '.figma-install-'));
  let backup;
  try {
    for (const entry of copiedEntries) await cp(join(source, entry), join(stage, entry), { recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true });
    if (present && (await exists(join(target, 'generated')))) await cp(join(target, 'generated'), join(stage, 'generated'), { recursive: true, force: false, errorOnExist: true });
    await writeFile(join(stage, marker), JSON.stringify({ format: 'figma-local-install-v2', version: pkg.version }) + '\n');
    if (present) { backup = `${target}.backup-${Date.now()}`; await rename(target, backup); }
    try { await rename(stage, target); }
    catch (error) { if (backup) await rename(backup, target); throw error; }
    return { root: target, reused: false, backup };
  } finally { await rm(stage, { recursive: true, force: true }); }
}

export async function main(argv = process.argv.slice(2)) {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Install Node.js 22 or newer first');
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (['--help', '--update', '--no-register', '--no-open'].includes(flag)) options[flag] = true;
    else if (['--target', '--package-root'].includes(flag) && argv[index + 1] && !argv[index + 1].startsWith('--')) options[flag] = argv[++index];
    else throw new Error(`Unknown option or missing value: ${flag}`);
  }
  if (options['--help']) {
    console.log('node scripts/install.mjs [--package-root PATH | --target PATH] [--update] [--no-register] [--no-open]\nDefault: copy the inspectable runtime sources bundled with this skill, register figma_local in Codex, and reveal the Figma manifest. Requires Node.js 22+ and Codex CLI for registration.');
    return;
  }
  if (options['--package-root'] && options['--target']) throw new Error('Choose an existing package or an embedded installation');
  const skillRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  let root = options['--package-root'] ? resolve(options['--package-root']) : undefined;
  if (!root && !options['--target']) {
    try {
      const locator = JSON.parse(await readFile(join(skillRoot, 'installation.json'), 'utf8'));
      if (typeof locator.packageRoot === 'string' && (await validPackage(locator.packageRoot))) root = resolve(locator.packageRoot);
    } catch {}
  }
  if (root && !(await validPackage(root))) throw new Error(`Existing package is incomplete: ${root}`);
  if (!root || (options['--update'] && (await exists(join(root, marker))))) {
    const source = await embeddedRoot(skillRoot);
    const target = root ?? resolve(options['--target'] ?? join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'figma-local-mcp'));
    const installed = await installEmbedded({ source, target, update: !!options['--update'] });
    root = installed.root;
    if (installed.backup) console.log(`Previous installation backed up to: ${installed.backup}`);
  }
  const result = spawnSync(process.execPath, [join(root, 'scripts/setup.mjs'), ...(options['--no-register'] ? [] : ['--register-mcp'])], { encoding: 'utf8', windowsHide: true });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.error || result.status !== 0) throw new Error(result.stderr || result.error?.message || 'MCP setup failed');
  await writeFile(join(skillRoot, 'installation.json'), JSON.stringify({ packageRoot: root }, null, 2) + '\n');
  const manifest = join(root, 'generated/figma-plugin/manifest.json');
  if (!options['--no-open']) {
    const command = process.platform === 'darwin' ? ['open', '-R', manifest] : process.platform === 'win32' ? ['explorer.exe', '/select,', manifest] : ['xdg-open', dirname(manifest)];
    const opened = spawnSync(command[0], command.slice(1), { windowsHide: true, stdio: 'ignore' });
    if (opened.error || opened.status !== 0) console.log(`Open the manifest folder manually: ${dirname(manifest)}`);
  }
  console.log('One-time Figma step: Plugins > Development > Import plugin from manifest, then run Figma Local MCP Auto. No pairing code is needed.');
  return { root, manifest };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
