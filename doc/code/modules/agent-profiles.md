# Agent Profiles

## Responsibility
Agent profiles provide reusable role instructions for main chat selection,
subagent creation, prompt resolution, and catalog display.

## Source Paths
- `src/agents/`
- `agents/`

## Key Files
- `src/agents/AgentProfiles.ts`: loads, resolves, validates, and exposes agent profile metadata.
- `src/agents/index.ts`: module export surface.
- `agents/<name>/AGENTS.md`: shipped bundled profile instructions.
- `doc/spec/agent-profile-baseline.md`: profile catalog and authoring rules.

## Runtime Contracts
Agent profiles shape prompts; they are not Plan Mode state. Selecting
`@planner` does not enter `plan_drafting`. Plan Mode still enters only through
the composer intent and send-time planning action.

Profiles are used by Agent prompt shaping, context replay, subagent task
configuration, and Web prompt resolution. Profile selection must remain
traceable in records that depend on it.

Profile bodies are injected when an agent is selected or switched. Later
history and replay records keep only an `AGENT_PROFILE_REF`; that reference may
include the profile definition path for traceability, but the path is not a
workspace root and must not be surfaced as the active work directory. The
Context Snapshot omits active-agent paths; workspace resolution stays controlled
by the runtime workspace prompt and run options.

## Edit Guidance
- Put profile loading and validation in `src/agents/`.
- Put default shipped profile content under package `agents/`; user external profiles stay in `agent.globalAgentsDir`.
- Update `doc/spec/agent-profile-baseline.md` when adding, removing, or changing shipped profiles.
- Keep profile behavior separate from Plan Mode lifecycle.

## Closest Tests
- `tests/unit/agent-profiles.test.ts`
- `tests/unit/profile-introspection-service.test.ts`
- `tests/unit/web-prompt-resolution.test.ts`
- `tests/unit/subagent-runner-agent-profile.test.ts`
