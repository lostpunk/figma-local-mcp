// Scope this resolver to one command: variables can be edited or removed between commands.
export function variableResolver() {
  let local: Promise<Map<string, Variable>> | undefined;
  return async (id: string, localOnly = false): Promise<Variable | null> => {
    local ??= figma.variables.getLocalVariablesAsync().then(variables =>
      new Map(variables.map(variable => [variable.id, variable])));
    let variables: Map<string, Variable>;
    try { variables = await local; }
    catch { throw new Error('LOCAL_VARIABLES_UNAVAILABLE: Could not read variables in this file. Check Figma connectivity and read get_design_system before retrying.'); }
    const variable = variables.get(id);
    if (variable) return variable;
    if (localOnly) return null;
    // Preserve support for already accessible library variables, without importing a library.
    try { return await figma.variables.getVariableByIdAsync(id); }
    catch { throw new Error('VARIABLE_LOOKUP_FAILED: The variable was not found locally and Figma could not resolve it by ID. Check the ID with get_design_system and check Figma connectivity.'); }
  };
}
