import { loadProjectRules } from './project-config.mjs';
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') {
  console.log('node project-rules.mjs --project PATH\nValidate .figma-design.json and read only its selected rule files. Does not modify the project or Figma.');
} else if (args.length !== 2 || args[0] !== '--project') {
  console.error('Usage: node project-rules.mjs --project PATH');
  process.exitCode = 1;
} else {
  try { console.log(JSON.stringify(await loadProjectRules(args[1]), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
