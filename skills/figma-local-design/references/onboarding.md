# First project setup

Design choices belong to a project, never to the global MCP installation. Offer setup after the first installation or when the user starts a new design project. Reuse clear preferences already supplied in the conversation; don't ask the same questions again. Updating the implementation of this skill is not a request to configure the maintainer's current project.

## Through the agent

Pass the user-selected project directory to `scripts/install.mjs --project PATH --non-interactive`. If the directory is not known, finish independent installation work and ask where the project rules should live. Never use the skill installation directory or the MCP checkout as a design project merely because it is the current directory.

The installer returns `needs_project`, `needs_input`, `configured`, `deferred` or `existing`. `needs_input` means installation is ready but project choices are not saved. Ask short questions in chat, preferably in two rounds:

1. Design system: preserve the open Figma file's current style, shadcn/ui reference, Material Design reference, custom system, or decide later. When the installer returns `welcome` and `distributionDefault`, show that welcome first and offer its first option as the default for new designs. The shared default is Gravity UI. In chat, carry the announced default into setup with designSystem: "distribution" when no other preference was supplied; explicit project/user choices take precedence. For custom, ask its name and any existing project documentation/kit references. Do not claim a reference option installs a vendor kit.
2. Theme, comfortable/compact density, web/mobile/both, optional font/brand color, and any additional rules. Keep unchosen settings unspecified. Do not ask all details when the user chose later.

Write the user's answers to a temporary JSON file and call the already installed skill's `scripts/onboarding.mjs --project PATH --answers FILE`. This only creates `.figma-design.json`; it does not restart/reinstall MCP or modify Figma. Example (values must come from the user):

```json
{
  "designSystem": "shadcn-ui",
  "name": "My project",
  "theme": "light",
  "density": "comfortable",
  "platform": "both",
  "fontFamily": "Inter",
  "primaryColor": "#2563EB",
  "rules": ["Use Russian interface text"]
}
```

`designSystem`: existing/shadcn-ui/material/custom/later. A package with `assets/distribution.json` also accepts `distribution` and saves that profile's reference library and rules as project-specific custom settings. This value is rejected when the profile is absent. Custom requires `libraryName`. Other fields are optional; `theme`, `density`, `platform` also accept `existing`. Omit font/color when keeping the design's existing values. Use `--design-answers FILE` on the installer when preferences are already known before installation.

## Manual terminal use

With a terminal attached, `scripts/install.mjs --project PATH` asks the same questions. Without PATH it asks for the project directory or allows deferring setup. The full-package `scripts/setup.mjs --codex --project PATH` supports the same flow. No terminal means structured questions instead of an interactive wait or automatic defaults.

Run `scripts/onboarding.mjs --project PATH` to configure another project later. No npm dependencies are needed. Existing `.figma-design.json`, including legacy or deferred settings, is never overwritten by the wizard; an invalid configuration is reported. To revise existing choices, edit that project file under the user's request and run project-rules.mjs to validate it.

Choosing later with a known project writes only an explicit deferred marker. Respect it: work from the task brief and existing Figma design without repeatedly asking or installing a default system. Choosing existing records reuse instructions and adds no starter tokens. Explicitly selected font/color are preferences to review against the connected file, not authority to replace shared tokens during unrelated edits. None of these choices synchronize or alter Figma until the user requests design work.
