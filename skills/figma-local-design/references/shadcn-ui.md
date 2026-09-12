# shadcn/ui profile

Use this convention for handoff to React projects using shadcn/ui. It is not a bundled React installation or vendor Figma kit.

Prefer project components/theme first. shadcn/ui components are editable code: structure and dimensions depend on preset and customization. Read relevant source or current [component docs](https://ui.shadcn.com/docs/components) before promising a particular API or default appearance.

Map semantic roles to COLOR variables: `background/foreground`, `card/card-foreground`, `primary/primary-foreground`, `secondary/secondary-foreground`, `muted/muted-foreground`, `accent/accent-foreground`, `destructive`, `border`, `input`, `ring`. This MCP prefixes them with `color/`. Use appropriate fill/text pairs and verify contrast.

[Theming docs](https://ui.shadcn.com/docs/theming) define the naming convention. The included [starter](../assets/shadcn-starter.json) is an editable light palette in hex, which this MCP accepts. It is not an exact transcription of any project's OKLCH/HSL theme; convert and verify actual theme values when given.

Names such as `Button/Primary`, `Button/Secondary`, `Input/Default`, `Input/Error`, `Card/Default` aid handoff. Separate COMPONENT nodes may depict states; this MCP cannot create ComponentSet variants or prototypes. Prefer authentic instances when `library.mode` is `local-components`.

Build only primitives required for the flow. Don't turn every layout into identical cards merely because Card exists. Preserve input labels, text hierarchy and error context.

Use an existing project icon family where available. The MCP cannot import SVG or create vector paths: use existing local icon components or identify icon insertion as a missing capability. Do not claim an approximation is an original icon.

For kits, consult [the shadcn/ui Figma page](https://ui.shadcn.com/docs/figma) and the user's available file. No kit is redistributed here. Component maps need real local COMPONENT IDs in the connected document.
