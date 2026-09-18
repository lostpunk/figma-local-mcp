# Gravity UI profile

Public-source reference, checked 2026-09-18. Use for new web interfaces when no other system was chosen. Explicit user preferences, project rules and an existing file's design take priority. For native apps or strongly branded sites, check that this reference fits the task. Selecting it does not import a Figma kit or install React packages.

The shared defaults and welcome are in [distribution.json](../assets/distribution.json). Read them for the selected profile; do not apply them to another system. Save new project choices with `designSystem: "distribution"` through onboarding.mjs. Existing/deferred choices remain unchanged. The saved library and rules are portable project settings, independent of the installation channel.

## Verified public references

- [UIKit repository](https://github.com/gravity-ui/uikit): open-source React components, documentation, Storybook and Figma links; UIKit is MIT-licensed. This profile contains original guidance and links, not copied kits, fonts, logos or source code. Refer to each asset's own terms when acquiring it.
- [Theming](https://github.com/gravity-ui/uikit/blob/main/docs/theming.md): use semantic colors for backgrounds (`base`), text (`text`), borders (`line`) and effects (`sfx`). Raw `private` palette values are implementation details. Branding needs coordinated base/hover/selection/link/contrast values for each supported theme, not a single replacement accent. Radius and font metrics are theme tokens too.
- [Typography](https://github.com/gravity-ui/uikit/blob/main/docs/typography.md) and [Text](https://gravity-ui.com/components/uikit/text): use the project's named text variants and semantic colors. Verify font availability before creating text styles; avoid interpreting a sample font as mandatory for all projects.
- [Layout](https://github.com/gravity-ui/uikit/blob/main/docs/layout.md): the default spacing base is 4 px, with a 2 px half-step; a project can change that base. Use its selected version and theme. Map the relevant tokens to Figma Auto Layout; a code utility name is not a Figma node ID.
- [Button](https://gravity-ui.com/components/uikit/button): `action` highlights the primary action, `normal` handles secondary actions, `flat` suits auxiliary actions. Usually use one action button per page. Sizes are xs/s/m/l/xl; loading, disabled and selected express different states. Confirm exact geometry in the selected kit/theme.
- [TextInput](https://gravity-ui.com/components/uikit/text-input): normal/clear views, s/m/l/xl sizes, label, disabled and invalid states. Error messages can sit inside or outside. Keep the control's purpose visible after typing; use a readable error message and consistent sizing in related controls.
- [Dialog](https://gravity-ui.com/components/uikit/dialog): header, body and footer actions for modal forms and confirmations. Configure closing behavior for Escape/outside clicks according to the scenario; check the target viewport instead of assuming a universal inset.
- [Icons](https://gravity-ui.com/icons): use a consistent icon family and appropriate meaning. Verify each selected asset before importing it through the local MCP.

## Applying the profile in Figma

Inspect existing collections, text styles and components first. Reuse actual local components when available; otherwise create native counterparts in reference mode and label them as adaptations. The local MCP cannot acquire a remote library merely from its URL.

Create explicit, source-verified foundations in the intended namespace. Do not allow create_style_guide's starter defaults to substitute another system's tokens. Preview sync_style_guide before changing a shared collection; a screen edit does not authorize a global rebrand. Theme handling must match the MCP's supported modes; unsupported modes are a limitation to report, not a reason to claim a complete theme sync.

The state lists in distribution.json are this skill's design review checklist, not guaranteed variant names in every vendor kit. Verify hover/focus/disabled/error/loading as relevant, text overflow and real prototype reactions. A screenshot alone does not establish working behavior or accessibility. If exact theme values or a kit are unavailable, identify the approximation and its proposed values rather than calling them official defaults.
