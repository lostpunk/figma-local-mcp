import { z } from 'zod';
import { lstat, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectConfigSchema } from './project-config.mjs';

// Shared, package-local defaults; never infer policy from user identity
// or installation metadata. A minimal/custom package may omit this file.
export const distributionSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^[a-z0-9-]{1,80}$/),
  label: z.string().min(1).max(200),
  welcome: z.string().min(1).max(2000),
  defaults: projectConfigSchema.pick({ profile: true, library: true, rules: true, componentStates: true }),
}).strict().superRefine((value, context) => {
  if (!value.defaults.library || value.defaults.library.mode !== 'reference') {
    context.addIssue({ code: 'custom', path: ['defaults', 'library'], message: 'A distribution default must describe a reference library' });
  } else if (Object.keys(value.defaults.library.components).length) {
    context.addIssue({ code: 'custom', path: ['defaults', 'library', 'components'], message: 'File-specific component IDs cannot be distributed' });
  }
});

export async function loadDistribution(packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))) {
  const path = join(packageRoot, 'assets', 'distribution.json');
  let info;
  try { info = await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!info.isFile() || info.isSymbolicLink() || info.size > 32768) throw new Error('Distribution settings must be a regular JSON file of at most 32 KiB');
  return distributionSchema.parse(JSON.parse(await readFile(path, 'utf8')));
}
