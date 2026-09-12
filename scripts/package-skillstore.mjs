import { cp, lstat, mkdir, readdir, rm } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(root, 'skills', 'figma-local-design');
const output = join(root, 'dist', 'skillstore', 'figma-local-design');
const files = [
  'SKILL.md',
  'version.json',
  'agents/openai.yaml',
  'package.json',
  'scripts/install.mjs',
  'scripts/setup.mjs',
  'scripts/local-plugin.mjs',
];
const directories = ['assets', 'references', 'runtime', 'plugin', 'src'];
const forbidden = new Set(['.github', '.git', '.skillstore-meta.json', 'installation.json']);

async function validate(directory) {
  for (const name of await readdir(directory)) {
    const path = join(directory, name);
    const stat = await lstat(path);
    const rel = relative(output, path).split('\\').join('/');
    if (forbidden.has(name)) throw new Error(`Forbidden SkillStore file: ${rel}`);
    if (stat.isSymbolicLink()) throw new Error(`Symlink in SkillStore package: ${rel}`);
    if (stat.isDirectory()) await validate(path);
  }
}

await rm(join(root, 'dist', 'skillstore'), { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const path of files) {
  const destination = join(output, path);
  await mkdir(dirname(destination), { recursive: true });
  await cp(join(source, path), destination);
}
for (const directory of directories) await cp(join(source, directory), join(output, directory), { recursive: true });
await validate(output);
console.log(`SkillStore package ready: ${output}`);
