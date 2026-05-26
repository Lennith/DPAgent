# Native Agent Profile Baseline

This document records the default agent profile set shipped with DPAgent after the native profile cleanup.

## Goal

Default profiles must be product-native, provider-neutral, and usable by both main chat `@agent` selection and `subagent_manage(action=list_agents)`.

The runtime contract stays unchanged:

- Bundled profiles ship with the package under `agents/<name>/AGENTS.md` and are loaded by default.
- User-managed external profiles live under `agent.globalAgentsDir/<name>/AGENTS.md`.
- `globalAgentsDir` points only to the user-managed external profile directory.
- Optional profile settings live beside the profile under `<profileDir>/<name>/agent.yaml`.
- Optional profile-specific skills live under `<profileDir>/<name>/skill/`.
- Workspace `AGENTS.md` remains supported.
- `@agent` selection and `subagent_manage(agent_name=...)` continue to use the same profile catalog.
- Omitting `agent_name` still creates an ad-hoc sub-agent.
- External profiles are always available for `@agent` selection, but they are hidden from `subagent_manage(action=list_agents)` unless `agent.yaml` sets `exposeAsSubagent: true`.

## Default Profiles

| Profile | Purpose |
| --- | --- |
| `browser` | Browser interaction and UI evidence collection. |
| `checkpoint` | Long-running work handoff and resume summaries. |
| `coding` | Scoped code implementation and bug fixes. |
| `design` | Product design, UX, and visual experience review. |
| `guard` | Safety boundaries for risky operations and scoped edits. |
| `health` | Repository health, test, build, and quality signals. |
| `investigate` | Root-cause analysis for bugs and regressions. |
| `planner` | Multi-step product and engineering implementation planning. |
| `qa` | User-flow QA and regression evidence. |
| `release` | Versioning, packaging, publish, and release verification. |
| `report` | Release notes, retrospectives, and progress summaries. |
| `research` | Read-only repository and technical research. |
| `review` | Code review for correctness and regression risk. |
| `security` | Security review for secrets, permissions, and trust boundaries. |

## Removed Legacy Profiles

The previous default catalog contained generated profiles imported from an external skill ecosystem. Those profiles referenced external paths, external tool names, and external workflow conventions that do not belong in the DPAgent default package.

The cleanup removes those profiles from the default package and folds their useful product intent into the native profiles:

| Removed profile | Native destination |
| --- | --- |
| `autoplan`, `plan-ceo-review`, `plan-design-review`, `plan-eng-review`, `office-hours` | `planner`, `design` |
| `browse`, `connect-chrome`, `setup-browser-cookies` | `browser`, `qa` |
| `qa-only` | `qa` |
| `benchmark`, `canary` | `health`, `qa`, `release` |
| `design-consultation`, `design-shotgun`, `design-html`, `design-review` | `design` |
| `setup-deploy`, `ship`, `land-and-deploy`, `document-release` | `release`, `report` |
| `careful`, `freeze`, `unfreeze` | `guard` |
| `learn`, `retro` | `checkpoint`, `report` |
| `cso` | `security` |
| `codex`, `gstack-upgrade`, `Me` | Removed from default catalog |

## Authoring Rules

Default profiles must follow these rules:

- Keep each `AGENTS.md` below 500 lines.
- Do not reference external AI product directories, external skill runtimes, or product-specific prompt tooling.
- Describe the agent mission, use cases, non-goals, operating rules, and output contract.
- Prefer stable product intent over implementation-specific tool names.
- Keep descriptions short enough for catalog display.
- External agent skills must live under that agent's own `skill/` directory.
- `agent.yaml` may set `loadGlobalSkills: false` to prevent that external
  agent from loading the Settings global skills directory. The default is
  `true`.
- `agent.yaml` may set `description`, `llmProfileId`, `llmModel`,
  `reasoningPreset`, and `promptAppend`.
- External agents do not define their own toolset, allowed tools, max steps, or
  timeout. Those controls inherit global/session runtime settings.
- Workspace skills under `workspaceDir/skills/` are generated or approved by
  the runtime governance flow and are separate from both global skills and
  external agent skills.

## Planner Profile And Plan Mode Boundary
The `planner` profile is an agent profile, not a Plan Mode state. Selecting
`@planner` can shape model behavior, but it does not enter `plan_drafting` by
itself.

Plan Mode is entered only through the composer intent and send-time
`planningAction: "enter_drafting"` contract. The planner profile may be used
with or without Plan Mode, and Plan Mode may use any allowed profile.
