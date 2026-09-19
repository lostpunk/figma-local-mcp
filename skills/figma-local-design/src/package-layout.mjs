import layout from './package-layout.json' with { type: 'json' };

if (layout.format !== 1) throw new Error('Unsupported package layout');
for (const section of ['runtime', 'skill', 'source']) {
  for (const kind of ['files', 'directories']) {
    const entries = layout[section]?.[kind];
    if (!Array.isArray(entries) || entries.some(path => typeof path !== 'string' || !path || path.includes('\\') || path.includes(':')
      || path.split('/').some(part => !part || part === '.' || part === '..'))) throw new Error('Unsafe package layout');
    Object.freeze(entries);
  }
  Object.freeze(layout[section]);
}
export const runtimeLayout = layout.runtime;
export const runtimeEntries = Object.freeze([...runtimeLayout.files, ...runtimeLayout.directories]);
export const skillLayout = Object.freeze({
  files: Object.freeze([...runtimeLayout.files, ...layout.skill.files]),
  directories: Object.freeze([...runtimeLayout.directories, ...layout.skill.directories]),
});
export const isRuntimeFile = name => runtimeLayout.files.includes(name)
  || runtimeLayout.directories.some(directory => name.startsWith(directory + '/'));
