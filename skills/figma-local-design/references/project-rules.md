# Project rules and UI libraries

Read `.figma-design.json` in the user-selected project root. At first installation or new-project setup, offer the choices in [onboarding.md](onboarding.md) if it is absent. Do not silently persist a library as the user's choice. A packaged distribution default must be announced and applied only under that package's scoped onboarding instructions. For ordinary edits preserve the existing design; don't force a questionnaire or write a configuration just for a small edit. An explicit deferred choice means follow the task brief and existing design without asking again.

Run `node <skill>/scripts/project-rules.mjs --project <selected-project-root>` before using project rules. The bundled CLI requires only Node.js, does not write files or access Figma, and returns `status: missing` when configuration is absent. Invalid fields or missing selected rule files are errors, not permission to silently fall back to defaults. It reads at most 64 KiB per file and refuses paths/symlinks escaping the selected project. See [design.config.example.json](../assets/design.config.example.json). This is validated guidance for the agent, not automatic enforcement on every MCP client.

| Field | Meaning |
| --- | --- |
| `schemaVersion` | `1`; omitted in older configurations is accepted as version 1 |
| `onboarding` | Project-specific configured/deferred choice and selected designSystem; optional for older files |
| `density` | `comfortable` or `compact`; guidance for the agent, not automatic geometry changes |
| `profile` | `shadcn-ui`, `custom`, or a named custom profile |
| `profileFile` | Optional project-relative Markdown profile |
| `library.name` | Intended UI library |
| `library.mode` | `reference` or `local-components` |
| `library.docs` | Primary docs URL; fetch only when relevant |
| `library.components` | Role-to-local-component-ID map for the current file |
| `foundation` | `name`, optional verified `collectionId`, `theme`, `fontFamily`, `colors`, `typography`, `spacing`, `radii` |
| `grid` | `columns`, `gutter`, `margin` in pixels |
| `naming` | Optional text templates for `frames`, `components`, `layers` |
| `componentStates` | Component role → required state names, such as Button → default/hover/focus |
| `viewports` | Design sizes, not a request to build extra screens |
| `rulesFiles` | Project-relative Markdown rule files |
| `rules` | Short project instructions |

Resolve rule/profile paths relative to the project. Read only selected files. Report missing required files rather than guessing their contents; continue independent planning where possible.

Foundation colors/radii use `{name, value}` arrays. Typography uses `{name, fontFamily, fontStyle, fontSize, lineHeight?}` with explicit fonts; spacing is a numeric array. CLI `guidePatch` contains only declared groups and never fills omitted colors or typography with starter defaults. `fontFamily` is a design preference, not an instruction to rewrite all text styles. Component mappings belong to a specific Figma file: verify each ID and actual type, not just the JSON shape.

## Repeatable foundation updates

1. Read `get_design_system`, including truncation. Resolve the intended collection using its configured ID or an unambiguous exact name; do not guess among duplicates.
2. If a collection exists and the task calls for a foundation change, use `sync_style_guide` with its actual ID, declared groups and `dryRun: true`. Inspect the before/after values. Omitted tokens/styles, other modes, pages and boards remain intact.
3. Apply the same patch with `dryRun: false` and a new operation ID only when its shared impact is within the user's request. A normal authorized foundation update needs no extra confirmation. A screen-only request does not authorize unrelated brand changes.
4. Read back the affected resources and export representative screens. Existing IDs remain stable; a repeat of the same values is a no-op. New tokens/styles are added, but unused resources are not deleted or renamed. New tokens use the default mode; this tool does not manage themes/mode overrides.

Ambiguous names, incompatible types and styles with variable bindings are rejected before applying a patch. Update bound typography through its variables instead. On apply failure the tool attempts to restore prior values/styles and remove new resources; inspect after errors. Existing visual specimens follow their bindings, but their creation-time hex/number captions are not rewritten, and newly added tokens do not get a new specimen board. `get_design_system` is the current source of token values.

For an absent namespace, build explicit creation arguments from the chosen profile/configuration and call `create_style_guide` once within the page budget. Do not rename a conflicting namespace to evade the duplicate check.

In `reference` mode, use the library's documented vocabulary and the project's component source to construct native Figma counterparts. Do not claim these are imported or exact vendor instances. Respect provided CSS variables, version and preset instead of assuming defaults.

In `local-components` mode, inspect mapped IDs with `get_node`, verify COMPONENT types in the connected file, and use `create_instance`. Do not substitute hand-drawn components when real library reuse is required. Ask for the missing local components or an explicit switch to reference mode. This MCP cannot import remote libraries, acquire kits, or instantiate an inaccessible remote component key. A library URL alone doesn't import anything.

For Material Design or an internal library, use `profile: "custom"` and supply available primary docs, token mapping and component roles. Add a `profileFile` when the user provides project-specific library rules; the onboarding wizard does not invent that file. Load only the selected profile; don't mix systems by default.

Rules such as “always use our Button” guide the agent. To enforce them for every client, implement explicit validation in MCP/plugin code as a requested change and test it. SKILL.md alone cannot enforce mandatory component reuse or permissions.

## Checking the result

Pass declared `foundation.spacing` to `audit_design.rules.spacing`. Resolve `componentStates` to actual component-set IDs and exact variant property values before including state rules. See [quality-checks.md](quality-checks.md). Grid specifications, naming templates and free-text rules still require review by the agent; the audit does not silently enforce them.
