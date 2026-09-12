# Design workflow

Start with the purpose, audience and requested screens. Read existing tokens/components before adding new ones. A small edit does not need a new design system. For a new product use the project profile and state reasonable nonblocking visual assumptions.

Customize `create_style_guide` from the brief or local theme. A starter for the default profile is [shadcn-starter.json](../assets/shadcn-starter.json). Check existing namespaces with `get_design_system`; creation with the same name is rejected. Check the document page budget first; use an existing pageId for the guide and place components/screens on existing pages when space is limited. See [file-limits.md](file-limits.md). The starter is this package's suggestion, not a vendor Figma kit.

- Name colors by meaning (background, foreground, primary, border, destructive) and bind them through `fillVariableId`/`strokeVariableId`.
- Bind spacing/radii through `variableBindings`, and text through `textStyleId`. Avoid changing existing shared tokens casually: bound layers elsewhere may change.
- Make recurring elements COMPONENT nodes; place `create_instance` instances on screens. For a real library kit follow `library.mode` in project-rules.md. Represent states needed for the flow (error, disabled, focus), without building an exhaustive library unless requested.
- Use auto layout for content stacks, buttons and lists. Absolute placement suits screen composition and overlays. Choose sizing/wrapping explicitly and check long labels and realistic content.
- Keep `create_scene` batches within 100 nodes. Parents precede children. Save returned IDs between calls. Validate one representative screen before replicating its structure.

Export key screens with `export_node` and inspect clipping, alignment, hierarchy, long text, spacing and requested viewport sizes. Large PNGs downscale to 4096px; export smaller frames if necessary. Separate static states from interactive behavior: the MCP does not create working prototypes.

Follow project accessibility targets. Useful baselines are WCAG AA text contrast (4.5:1, or 3:1 for qualifying large text) and non-text contrast where applicable. Calculate actual color pairs before reporting measured compliance. Use visible focus cues, meaningful labels and non-color state indicators. A 44px target is a comfortable project preference; WCAG 2.2 AA's target-size criterion has a 24 CSS px minimum with exceptions, not a universal 44px rule.

Sources: [text contrast](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html), [non-text contrast](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html), [target size](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html). Consult current primary docs for exact conformance decisions.

Finish with page/frame IDs, the preview actually inspected, and any approximated library elements or missing states that affect handoff.
