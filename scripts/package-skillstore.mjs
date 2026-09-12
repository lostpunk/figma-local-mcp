import { cp, lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
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
const externalUrl = /https?:\/\/[^\s<>()\[\]{}]+/g;
const schemaIdAliases = new Map([
  ['https://raw.githubusercontent.com/ajv-validator/ajv/master/lib/refs/data.json#', 'urn:figma-local:ajv:data'],
  ['http://json-schema.org/draft-07/schema#', 'urn:figma-local:json-schema:draft-07'],
  ['https://json-schema.org/draft/2019-09/schema#', 'urn:figma-local:json-schema:draft-2019-09'],
]);

function publicOrigin(value) {
  try {
    const url = new URL(value);
    return url.origin;
  } catch {
    return 'external reference';
  }
}

async function sanitizeNoticeLinks(path) {
  const content = await readFile(path, 'utf8');
  await writeFile(path, content.replace(externalUrl, publicOrigin));
}

async function sanitizeRuntime(path) {
  let content = await readFile(path, 'utf8');
  content = content.split('\n').map(line => /^\s*(?:\/\/|\*)/.test(line) ? line.replace(externalUrl, publicOrigin) : line).join('\n');
  // These are Ajv's local schema identity strings, not network endpoints. In
  // the Store-only bundle they are replaced consistently, because its static
  // link policy rejects URL fragments even when no request can occur.
  for (const [source, alias] of schemaIdAliases) content = content.replaceAll(source, alias);
  await writeFile(path, content);
}

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
// Dependency comments and notices can contain deep external source links (commit
// hashes, issue IDs, fragments). They are not used by the local runtime, and
// SkillStore forbids publishing such links. Keep the code and notices readable,
// while reducing those references to their public origin in the Store-only copy.
await sanitizeRuntime(join(output, 'runtime', 'server.mjs'));
await sanitizeNoticeLinks(join(output, 'runtime', 'THIRD_PARTY_NOTICES.md'));
await validate(output);
console.log(`SkillStore package ready: ${output}`);
