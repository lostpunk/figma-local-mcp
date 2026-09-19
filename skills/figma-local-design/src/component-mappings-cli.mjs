import { resolveComponentMappings } from './component-mappings.mjs';

async function main(args) {
  if (args.length === 1 && args[0] === '--help') {
    console.log('node component-mappings.mjs --project PATH < component-details-or-context.json\nRead-only project mappings. Input: JSON data from local get_component_details or get_design_context, at most 4 MiB.'); return;
  }
  if (args.length !== 2 || args[0] !== '--project' || !args[1] || args[1].startsWith('--'))
    throw new Error('Usage: component-mappings.mjs --project PATH < component-details-or-context.json');
  const chunks = []; let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 4 * 1024 * 1024) throw new Error('Component input exceeds 4 MiB; use a smaller context page');
    chunks.push(chunk);
  }
  let input;
  try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('Expected JSON data from get_component_details or get_design_context'); }
  console.log(JSON.stringify(await resolveComponentMappings(args[1], input)));
}
main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
