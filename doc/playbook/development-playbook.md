# Development Playbook

## Daily Workflow
1. Start from latest `main` on a focused branch unless instructed otherwise.
2. Inspect `git status --short --ignored` before edits.
3. Read the relevant PRD/spec/playbook document before changing module ownership or user-visible behavior.
4. Keep behavior-preserving refactors behavior-preserving.
5. Stage paths explicitly.
6. Commit focused changes and open a GitHub pull request for public review.
7. Use subagent review when requested; P0/P1 findings block the next node.

## Refactor Rules
- Split by responsibility, not line count alone.
- Keep public entry files as facades or domain aggregates.
- Extract abstractions only from repeated or stable logic.
- Do not introduce compatibility branches, test-only production logic, or duplicate fallback protocols.
- If a large file is a clear aggregate, keep it and explain the reason in the handoff.

## Test Routing
- Backend structure changes: TypeScript build and closest unit suites.
- LLM/provider changes: provider routing, payload, tool protocol, runtime contract, and OpenAI/Anthropic tests.
- Context changes: replay, projection, compression, overflow, budget, and toolcall-context tests.
- Frontend changes: closest UI unit tests plus `npm run build:web`.
- Release candidates: [release gate overview](release-gate-overview.md).

## Release And Publish References
- [Release gate overview](release-gate-overview.md)
- [Release E2E gate](release-e2e-gate.md)
- [Release toolcall context gate](release-toolcall-context-gate.md)
- [GitHub release](github-release.md)
- [NPM official publish](npm-official-publish.md)
- [Local config and profile hygiene](local-config-profile-hygiene.md)

## Operational References
- [Windows easy-run handoff](windows-easy-run-handoff.md)
- [Logging guide](logging-guide.md)
- [UX iteration standard](ux-iteration-standard.md)

## Documentation Rule
`doc/` is the single current documentation source. Historical notes may live under `doc/history/`, internal-only mirror or registry procedures may live under `doc/internal/`, and current behavior must be described in the appropriate current layer: `doc/prd/`, `doc/guide/`, `doc/design/`, `doc/spec/`, `doc/code/`, or `doc/playbook/`.
