import { cp, lstat, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createFileTransaction } from '../src/install-files.mjs';
import { prepareLocalPlugin } from './local-plugin.mjs';
import { hash, isRuntimeFile, readManifest, skillPrefix, treeFiles, verifyFiles } from './release-files.mjs';
import { verifyInstallation } from './verify-install.mjs';

async function optionalRead(path) {
  try { return await readFile(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function digest(path) { const bytes = await optionalRead(path); return bytes === null ? null : hash(bytes); }
async function realDirectory(path) {
  if (!(await lstat(path)).isDirectory() || (await lstat(path)).isSymbolicLink()) throw new Error(`Not a real directory: ${path}`);
}
async function copyFiles(source, destination, files) {
  for (const name of Object.keys(files)) {
    await mkdir(dirname(join(destination, name)), { recursive: true, mode: 0o700 });
    await cp(join(source, name), join(destination, name), { errorOnExist: true, force: false });
  }
}

// Maintainer-only updater. Recipient installation remains scripts/install.mjs.
// Injectable filesystem/verification functions are used only by rollback tests.
export async function updateLocal({ source, codexHome, verify = verifyInstallation, move = rename }) {
  source = resolve(source); codexHome = resolve(codexHome);
  await realDirectory(codexHome);
  const lockPath = join(codexHome, '.figma-local-update.lock');
  const lock = await open(lockPath, 'wx', 0o600).catch(error => {
    if (error.code === 'EEXIST') throw new Error('Local update is locked. Check the previous process and backup transaction before removing .figma-local-update.lock');
    throw error;
  });
  let stage, backup, preserveRecovery = false;
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid }) + '\n');
    const runtime = join(codexHome, 'figma-local-mcp'), skill = join(codexHome, 'skills/figma-local-design');
    await realDirectory(runtime); await realDirectory(join(codexHome, 'skills')); await realDirectory(skill);
    const marker = JSON.parse(await readFile(join(runtime, '.skill-install.json'), 'utf8'));
    if (!['figma-local-install-v1', 'figma-local-install-v2'].includes(marker.format)) throw new Error('Runtime is not a managed installation');
    const locator = JSON.parse(await readFile(join(skill, 'installation.json'), 'utf8'));
    if (resolve(locator.packageRoot ?? '') !== runtime || JSON.parse(await readFile(join(skill, 'package.json'), 'utf8')).name !== 'figma-local-mcp') {
      throw new Error('Standalone skill belongs to a different installation');
    }
    const manifest = await readManifest(source);
    await verifyFiles(source, manifest.files);
    const runtimeFiles = Object.fromEntries(Object.entries(manifest.files).filter(([name]) => isRuntimeFile(name)));
    const skillFiles = Object.fromEntries(Object.entries(manifest.files).filter(([name]) => name.startsWith(skillPrefix)).map(([name, value]) => [name.slice(skillPrefix.length), value]));
    const preservedNames = ['generated/pairing-key.json', 'generated/asset-access.json'];
    const before = await Promise.all(preservedNames.map(name => digest(join(runtime, name))));
    if (before[0] === null) throw new Error('Existing installation has no pairing key; repair it before updating');
    const configurationBefore = await digest(join(codexHome, 'config.toml'));
    const metadataBefore = await digest(join(skill, '.skillstore-meta.json'));
    const locatorBefore = await digest(join(skill, 'installation.json'));
    stage = await mkdtemp(join(codexHome, '.figma-update-'));
    const stagedRuntime = join(stage, 'runtime'), stagedSkill = join(stage, 'skill');
    await copyFiles(source, stagedRuntime, runtimeFiles);
    await copyFiles(join(source, skillPrefix), stagedSkill, skillFiles);
    await treeFiles(join(runtime, 'generated')); // Reject symlinks before copying private local state.
    await cp(join(runtime, 'generated'), join(stagedRuntime, 'generated'), { recursive: true });
    const metadata = await optionalRead(join(skill, '.skillstore-meta.json'));
    if (metadata !== null) await writeFile(join(stagedSkill, '.skillstore-meta.json'), metadata, { mode: 0o600 });
    await writeFile(join(stagedSkill, 'installation.json'), JSON.stringify({ ...locator, packageRoot: runtime }, null, 2) + '\n', { mode: 0o600 });
    await writeFile(join(stagedRuntime, '.skill-install.json'), JSON.stringify({ format: 'figma-local-install-v2', version: manifest.version }) + '\n', { mode: 0o600 });
    await prepareLocalPlugin(stagedRuntime);
    await verifyFiles(stagedRuntime, runtimeFiles);
    await verifyFiles(stagedSkill, skillFiles);
    const verification = await verify(stagedRuntime, stagedSkill, manifest.version);
    // Detect accidental writes during verification, and concurrent changes to user settings.
    await verifyFiles(stagedRuntime, runtimeFiles); await verifyFiles(stagedSkill, skillFiles);
    for (let index = 0; index < preservedNames.length; index++) {
      if (await digest(join(runtime, preservedNames[index])) !== before[index] || await digest(join(stagedRuntime, preservedNames[index])) !== before[index]) throw new Error('Private installation state changed during staging');
    }
    if (configurationBefore !== await digest(join(codexHome, 'config.toml')) || metadataBefore !== await digest(join(skill, '.skillstore-meta.json'))
      || locatorBefore !== await digest(join(skill, 'installation.json'))) throw new Error('Installation settings changed during staging; retry');
    await mkdir(join(codexHome, 'backups'), { recursive: true, mode: 0o700 });
    await realDirectory(join(codexHome, 'backups'));
    backup = await mkdtemp(join(codexHome, 'backups', `figma-local-${manifest.version}-`));
    // Keep the runtime root and mutable generated/ state at their stable paths.
    // A running server can create logs at any point; never rename their parent.
    await treeFiles(runtime);
    const runtimeBackup = join(backup, 'runtime'), skillBackup = join(backup, 'skill');
    await cp(runtime, runtimeBackup, { recursive: true, errorOnExist: true, force: false });
    const replacements = [...Object.keys(runtimeFiles), '.skill-install.json',
      'generated/figma-plugin/manifest.json', 'generated/figma-plugin/code.js', 'generated/figma-plugin/ui.html'];
    const journal = { version: manifest.version, stage, status: 'prepared', runtimeFiles: replacements,
      entries: [
        { target: runtime, staged: stagedRuntime, backup: runtimeBackup, strategy: 'files' },
        { target: skill, staged: stagedSkill, backup: skillBackup, strategy: 'directory' },
      ] };
    const writeJournal = () => writeFile(join(backup, 'transaction.json'), JSON.stringify(journal, null, 2) + '\n', { mode: 0o600 });
    await writeJournal();
    const runtimeTransaction = createFileTransaction({ target: runtime, staged: stagedRuntime, backup: runtimeBackup, files: replacements, recovery: join(stage, 'restore'), move });
    let skillBackedUp = false, skillPromoted = false;
    try {
      await runtimeTransaction.apply();
      journal.status = 'runtime_updated'; await writeJournal();
      await move(skill, skillBackup); skillBackedUp = true;
      await move(stagedSkill, skill); skillPromoted = true;
      journal.status = 'installed'; await writeJournal();
    } catch (error) {
      try {
        if (skillPromoted) await rename(skill, stagedSkill);
        if (skillBackedUp) await rename(skillBackup, skill);
        await runtimeTransaction.rollback();
        journal.status = 'rolled_back'; await writeJournal();
      } catch (rollbackError) {
        preserveRecovery = true;
        throw new Error(`Update and rollback failed. Keep recovery files at ${backup} and ${stage}; update lock retained. ${rollbackError.message}`, { cause: error });
      }
      throw new Error(`Update failed; previous runtime and skill restored. ${error.message}`, { cause: error });
    }
    return { version: manifest.version, ...verification, runtimeBackup: join(backup, 'runtime'), skillBackup: join(backup, 'skill'),
      pairingKeyPreserved: true, assetPolicyPreserved: true, configurationPreserved: true, metadataPreserved: true,
      liveFigmaVerification: 'pending_restart', published: false };
  } finally {
    await lock.close();
    if (!preserveRecovery) {
      if (stage) await rm(stage, { recursive: true, force: true });
      await rm(lockPath, { force: true });
    }
  }
}
