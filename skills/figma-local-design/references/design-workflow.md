# Design workflow

Start with the purpose, audience and requested screens. Read existing tokens/components before adding new ones. A small edit does not need a new design system. For a new product use the project profile and state reasonable nonblocking visual assumptions.

For large files, read `get_node` / `get_selection` with shallow depth and `fields: []` for structure, then request only needed fields on chosen IDs. Responses default to a 1 MiB UTF-8 budget (up to 4 MiB via `maxResponseBytes`). Follow `nextChildOffset` on the same root with `depth >= 1`, or `nextSelectionOffset` for selection roots. Read truncated descendants separately by their IDs. `omittedProperties` means the response is incomplete; a focused read may still omit a property larger than the budget. Restart tree/selection traversal after edits that change ordering.

For complete local library discovery, `get_design_system` returns independent `pagination` for collections, variables and textStyles. Pass each returned `nextOffset` through `offsets` and retain `revision` and filters. A changed revision requires restarting from the first page. Use `collectionId` and `variableNamePrefix` to find a specific token; `prefix` matches collection/text-style names. Collections do not scope text styles.

Customize `create_style_guide` from the brief or local theme. A starter for the shadcn/ui profile, when selected, is [shadcn-starter.json](../assets/shadcn-starter.json). Check existing namespaces with `get_design_system`; creation with the same name is rejected. Check the document page budget first; use an existing pageId for the guide and place components/screens on existing pages when space is limited. See [file-limits.md](file-limits.md). The starter is this package's suggestion, not a vendor Figma kit.

For an existing foundation use `sync_style_guide` with a verified collectionId and a patch containing only intended changes. Preview before applying; see [project-rules.md](project-rules.md). Reuse existing components after inspecting their IDs/properties; the selected grid, naming templates and componentStates guide creation and review. Missing library components are not instantiated automatically.

- Name colors by meaning (background, foreground, primary, border, destructive) and bind them through `fillVariableId`/`strokeVariableId`.
- Bind spacing/radii through `variableBindings`, and text through `textStyleId`. Avoid changing existing shared tokens casually: bound layers elsewhere may change.
- Make recurring elements COMPONENT nodes; place `create_instance` instances on screens. For a real library kit follow `library.mode` in project-rules.md. Represent states needed for the flow (error, disabled, focus), without building an exhaustive library unless requested.
- Use auto layout for content stacks, buttons and lists. Absolute placement suits screen composition and overlays. Choose sizing/wrapping explicitly and check long labels and realistic content.
- For editable text, use fixed width with automatic height for paragraphs when the surrounding layout supports growth. Fixed-height labels are appropriate when their actual rendering fits. Do not silence an overflow finding by changing the resize mode without checking the rendered result and neighbouring elements.
- Build menus from separate items and totals from separate label/value columns. Use Auto Layout gaps/alignment instead of repeated spaces or blank lines as structural spacing; preserve intentional whitespace in supplied content.
- When editing an existing screen, inspect its sizing and shared bindings first. A token, component or layout change can affect more than the selected layer; keep it within the requested scope.
- Keep `create_scene` batches within 100 nodes. Parents precede children. Save returned IDs between calls. Validate one representative screen before replicating its structure.

Run `audit_design` on the changed frame/page with applicable project spacing and verified component-state rules; see [quality-checks.md](quality-checks.md). Inspect coverage limits and review candidates before fixing. Structural checks do not replace visual review.

Export key screens with `export_node` and inspect clipping, alignment, hierarchy, long text, spacing and requested viewport sizes. Large PNGs downscale to 4096px; export smaller frames if necessary. Separate static states from verified interactive behavior: prototype tools can create reactions, but a static export does not prove they work in presentation mode. See [assets-variants-prototypes.md](assets-variants-prototypes.md).

Follow project accessibility targets. Useful baselines are WCAG AA text contrast (4.5:1, or 3:1 for qualifying large text) and non-text contrast where applicable. Calculate actual color pairs before reporting measured compliance. Use visible focus cues, meaningful labels and non-color state indicators. A 44px target is a comfortable project preference; WCAG 2.2 AA's target-size criterion has a 24 CSS px minimum with exceptions, not a universal 44px rule.

Sources: [text contrast](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html), [non-text contrast](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html), [target size](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html). Consult current primary docs for exact conformance decisions.

Report the audit root, visited/checked counts, remaining findings and incomplete checks. Explicit spacing, design-system and component-state rules are checked only when supplied; a zero-finding default audit does not prove conformity to the project system.

Finish with page/frame IDs, the preview actually inspected, and any approximated library elements or missing states that affect handoff.
