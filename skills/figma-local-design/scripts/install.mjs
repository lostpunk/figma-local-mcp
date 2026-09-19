import { access, cp, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile, open } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { prepareLocalPlugin } from './local-plugin.mjs';
import { regularFiles, compareFiles, createFileTransaction } from '../src/install-files.mjs';
import { checkInstallation } from '../src/installation-check.mjs';
import { runtimeEntries } from '../src/package-layout.mjs';

const marker = '.skill-install.json';
const requiredEntries = ['package.json', 'runtime/server.mjs', 'plugin/manifest.json', 'plugin/code.js', 'plugin/ui.html', 'scripts/setup.mjs', 'scripts/local-plugin.mjs', 'src/pairing.mjs'];
const copiedEntries = runtimeEntries;

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

export async function installEmbedded({ source, target, update = false, move = rename }) {
  source = resolve(source); target = resolve(target);
  await assertInspectableSource(source);
  const files = [];
  for (const entry of copiedEntries) files.push(...await regularFiles(join(source, entry), entry));
  const pkg = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
  await mkdir(dirname(target), { recursive: true });
  const lockPath = join(dirname(target), '.figma-local-update.lock');
  const lock = await open(lockPath, 'wx', 0o600).catch(error => {
    if (error.code === 'EEXIST') throw new Error('Another installation/update is running or needs recovery: .figma-local-update.lock');
    throw error;
  });
  let stage, backup, keepRecovery = false;
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid }) + '\n');
    const present = await exists(target);
    let reused = false;
    if (present) {
      await regularFiles(target); // Also reject nested symlinks before backup or replacement.
      let previous;
      try { previous = JSON.parse(await readFile(join(target, marker), 'utf8')); } catch {}
      if (!['figma-local-install-v1', 'figma-local-install-v2'].includes(previous?.format)) throw new Error('Target already exists and is not a managed installation; use --package-root for an existing checkout');
      if (previous.format === 'figma-local-install-v2' && previous.version === pkg.version) {
        try { await compareFiles(source, target, files); reused = true; } catch (error) { if (!update) throw error; }
      }
      if (!reused && !update) throw new Error('Another release is installed. Use --update to replace it with a backup');
    }
    if (reused) {
      try { return { root: target, reused: true, synchronization: await checkInstallation(target, pkg.version) }; }
      catch { /* Repair generated plugin files through the same staged transaction. */ }
    }
    stage = await mkdtemp(join(dirname(target), '.figma-install-'));
    for (const entry of copiedEntries) await cp(join(source, entry), join(stage, entry), { recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true });
    if (present && await exists(join(target, 'generated'))) await cp(join(target, 'generated'), join(stage, 'generated'), { recursive: true, force: false, errorOnExist: true });
    await prepareLocalPlugin(stage);
    await writeFile(join(stage, marker), JSON.stringify({ format: 'figma-local-install-v2', version: pkg.version }) + '\n', { mode: 0o600 });
    await compareFiles(source, stage, files);
    const synchronization = await checkInstallation(stage, pkg.version);
    // Recheck the source after executing the staged self-check.
    await compareFiles(source, stage, files);
    if (!present) {
      await move(stage, target);
      stage = undefined;
      return { root: target, reused: false, synchronization };
    }
    backup = await mkdtemp(`${target}.backup-`);
    await cp(target, backup, { recursive: true });
    const replacements = [...(reused ? [] : files), marker,
      'generated/figma-plugin/manifest.json', 'generated/figma-plugin/code.js', 'generated/figma-plugin/ui.html'];
    if (!await exists(join(target, 'generated/pairing-key.json'))) replacements.push('generated/pairing-key.json');
    else if (!(await readFile(join(target, 'generated/pairing-key.json'))).equals(await readFile(join(stage, 'generated/pairing-key.json')))) throw new Error('Installation key changed during preparation; retry');
    const journal = { version: pkg.version, target, stage, backup, runtimeFiles: replacements, status: 'prepared' };
    const saveJournal = () => writeFile(join(backup, 'update-transaction.json'), JSON.stringify(journal, null, 2) + '\n', { mode: 0o600 });
    await saveJournal();
    const transaction = createFileTransaction({ target, staged: stage, backup, files: replacements, recovery: join(stage, '.restore'), move });
    try {
      await transaction.apply();
      await compareFiles(source, target, files);
      await checkInstallation(target, pkg.version);
      journal.status = 'installed'; await saveJournal();
    } catch (error) {
      try { await transaction.rollback(); journal.status = 'rolled_back'; await saveJournal(); }
      catch (rollbackError) {
        keepRecovery = true;
        throw new Error(`Update and rollback failed. Keep recovery files at ${backup} and ${stage}; lock retained. ${rollbackError.message}`, { cause: error });
      }
      throw new Error(`Update failed; previous runtime restored. ${error.message}`, { cause: error });
    }
    return { root: target, reused, backup, synchronization };
  } finally {
    await lock.close();
    if (!keepRecovery) {
      try { if (stage) await rm(stage, { recursive: true, force: true }); }
      finally { await rm(lockPath, { force: true }); }
    }
  }
}

export async function main(argv = process.argv.slice(2)) {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Install Node.js 22 or newer first');
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (['--help', '--update', '--no-register', '--no-open', '--non-interactive', '--check'].includes(flag)) options[flag] = true;
    else if (['--target', '--package-root', '--project', '--design-answers'].includes(flag) && argv[index + 1] && !argv[index + 1].startsWith('--')) options[flag] = argv[++index];
    else throw new Error(`Unknown option or missing value: ${flag}`);
  }
  if (options['--help']) {
    console.log('node scripts/install.mjs [--package-root PATH | --target PATH] [--update | --check] [--no-register] [--no-open] [--project PATH] [--design-answers FILE] [--non-interactive]\nInstall the local runtime and prepare the Figma plugin. With --project, offer first-time design choices; existing rules are preserved. Non-interactive runs return questions for the agent instead of choosing defaults.');
    return;
  }
  if (options['--check'] && options['--update']) throw new Error('Choose --check or --update');
  if (options['--package-root'] && options['--target']) throw new Error('Choose an existing package or an embedded installation');
  if (options['--design-answers'] && !options['--project']) throw new Error('--design-answers requires --project');
  const skillRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  let root = options['--package-root'] ? resolve(options['--package-root']) : undefined;
  if (!root && !options['--target']) {
    try {
      const locator = JSON.parse(await readFile(join(skillRoot, 'installation.json'), 'utf8'));
      if (typeof locator.packageRoot === 'string' && ((await exists(join(locator.packageRoot, marker))) || (await validPackage(locator.packageRoot)))) root = resolve(locator.packageRoot);
    } catch {}
  }
  const expectedVersion = JSON.parse(await readFile(join(skillRoot, 'package.json'), 'utf8')).version;
  if (options['--check']) {
    root ??= resolve(options['--target'] ?? join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'figma-local-mcp'));
    const source = await embeddedRoot(skillRoot), files = [];
    for (const entry of copiedEntries) files.push(...await regularFiles(join(source, entry), entry));
    await compareFiles(source, root, files);
    const synchronization = await checkInstallation(root, expectedVersion);
    console.log(JSON.stringify({ ...synchronization, live: 'not_checked' }));
    return { root, synchronization };
  }
  if (root && !(await exists(join(root, marker))) && !(await validPackage(root))) throw new Error(`Existing package is incomplete: ${root}`);
  if (!root || (await exists(join(root, marker)))) {
    const source = await embeddedRoot(skillRoot);
    const target = root ?? resolve(options['--target'] ?? join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'figma-local-mcp'));
    const installed = await installEmbedded({ source, target, update: !!options['--update'] });
    root = installed.root;
    if (installed.backup) console.log(`Previous installation backed up to: ${installed.backup}`);
  }
  const result = spawnSync(process.execPath, [join(root, 'scripts/setup.mjs'), ...(options['--no-register'] ? [] : ['--register-mcp'])], { encoding: 'utf8', windowsHide: true });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.error || result.status !== 0) throw new Error(result.stderr || result.error?.message || 'MCP setup failed');
  const synchronization = await checkInstallation(root, expectedVersion);
  let locator = {};
  try { locator = JSON.parse(await readFile(join(skillRoot, 'installation.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const locatorPath = join(skillRoot, 'installation.json'), locatorTemp = locatorPath + `.${process.pid}.tmp`;
  try {
    await writeFile(locatorTemp, JSON.stringify({ ...locator, packageRoot: root }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(locatorTemp, locatorPath);
  } finally { await rm(locatorTemp, { force: true }); }
  console.log(`Installation synchronization:\n${JSON.stringify(synchronization, null, 2)}`);
  const manifest = join(root, 'generated/figma-plugin/manifest.json');
  if (!options['--no-open']) {
    const command = process.platform === 'darwin' ? ['open', '-R', manifest] : process.platform === 'win32' ? ['explorer.exe', '/select,', manifest] : ['xdg-open', dirname(manifest)];
    const opened = spawnSync(command[0], command.slice(1), { windowsHide: true, stdio: 'ignore' });
    if (opened.error || opened.status !== 0) console.log(`Open the manifest folder manually: ${dirname(manifest)}`);
  }
  const { onboardProject } = await import('./onboarding.mjs');
  const design = await onboardProject({ projectRoot: options['--project'], answersFile: options['--design-answers'],
    interactive: !options['--non-interactive'] && !!process.stdin.isTTY && !!process.stdout.isTTY });
  console.log(`Project design setup:\n${JSON.stringify(design, null, 2)}`);
  console.log('After an update, fully restart the MCP client and Figma Local MCP Auto. Keep using the same manifest path; verify get_connection versions and readiness after restarting.');
  console.log('First installation or a changed path only: Plugins > Development > Import plugin from manifest, then run Figma Local MCP Auto. No pairing code is needed.');
  return { root, manifest, design, synchronization };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
