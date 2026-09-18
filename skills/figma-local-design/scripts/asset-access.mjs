import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAssetAccess, updateAssetAccess } from '../src/asset-access.mjs';

try {
  let root = dirname(dirname(fileURLToPath(import.meta.url)));
  let action = 'list', directory, selected = false;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--help' && args.length === 1) {
      console.log('node scripts/asset-access.mjs [--package-root PATH] [--list | --allow ABSOLUTE_DIRECTORY | --remove ABSOLUTE_DIRECTORY | --clear]\nChoose only directories needed for the requested asset import. Missing policy denies path imports. Changes apply without restarting MCP.');
      process.exit(0);
    }
    if (flag === '--package-root' && args[i + 1]) root = resolve(args[++i]);
    else if (['--allow', '--remove'].includes(flag) && args[i + 1] && !selected) {
      action = flag.slice(2); directory = args[++i]; selected = true;
    } else if (['--list', '--clear'].includes(flag) && !selected) { action = flag.slice(2); selected = true; }
    else throw new Error('Invalid arguments; use --help');
  }
  const policy = action === 'list' ? await readAssetAccess(root) : await updateAssetAccess(root, action, directory);
  console.log(JSON.stringify(policy, null, 2));
} catch (error) { console.error(error.message); process.exitCode = 1; }
