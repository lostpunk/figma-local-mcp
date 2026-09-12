# Project rules and UI libraries

Read `.figma-design.json` in the user-selected project root. If absent, default to the shadcn/ui reference profile and a light theme, using Inter only when existing typography is unspecified. Don't write a configuration merely to perform a small edit.

See [design.config.example.json](../assets/design.config.example.json). This is an agent-read convention, not an automatically enforced MCP policy.

| Field | Meaning |
| --- | --- |
| `profile` | `shadcn-ui`, `custom`, or a named custom profile |
| `profileFile` | Optional project-relative Markdown profile |
| `library.name` | Intended UI library |
| `library.mode` | `reference` or `local-components` |
| `library.docs` | Primary docs URL; fetch only when relevant |
| `library.components` | Role-to-local-component-ID map for the current file |
| `foundation` | Namespace, typography, theme and spacing preferences |
| `viewports` | Design sizes, not a request to build extra screens |
| `rulesFiles` | Project-relative Markdown rule files |
| `rules` | Short project instructions |

Resolve rule/profile paths relative to the project. Read only selected files. Report missing required files rather than guessing their contents; continue independent planning where possible.

In `reference` mode, use the library's documented vocabulary and the project's component source to construct native Figma counterparts. Do not claim these are imported or exact vendor instances. Respect provided CSS variables, version and preset instead of assuming defaults.

In `local-components` mode, inspect mapped IDs with `get_node`, verify COMPONENT types in the connected file, and use `create_instance`. Do not substitute hand-drawn components when real library reuse is required. Ask for the missing local components or an explicit switch to reference mode. This MCP cannot import remote libraries, acquire kits, or instantiate an inaccessible remote component key. A library URL alone doesn't import anything.

For Material UI or an internal library, set `profile: "custom"`, supply `profileFile`, primary docs, token mapping and component roles. Load only the selected profile; don't mix systems by default.

Rules such as “always use our Button” guide the agent. To enforce them for every client, implement explicit validation in MCP/plugin code as a requested change and test it. SKILL.md alone cannot enforce mandatory component reuse or permissions.
