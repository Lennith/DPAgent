# DPAgent Release Notes: 2.3.0

## Highlights

- Add Arena, a Share/Fork-level workflow for comparing up to four contestant branches from the same source session context.
- Lock the source session during Arena runs, hide unpromoted branch and judge sessions from normal session access, and converge only after the user selects a winner.
- Support Answer Arena and branch-confined Implementation Arena with proposal/apply safety checks before source workspace changes.
- Add setup-first LLM configuration, package-native web access, session fork, and Todo cleanup with unified confirmation dialogs.

## Verification Scope

- Added Arena store, route, workspace, submit-tool, Web UI, and tool registry coverage.
- Verified branch LLM runtime overrides, source lock guards, hidden session projection, judge/winner boundaries, proposal stale-source/stale-branch rejection, and mobile Arena UI rendering.
- Release publishing is intentionally deferred while the internal npm registry is unreachable; package metadata is prepared for the next release gate run.
