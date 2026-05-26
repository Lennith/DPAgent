# Release E2E Gate

## Purpose
The release E2E gate covers high-risk end-to-end user flows that unit tests
cannot fully validate.

## Command
```bash
npm run test:release-e2e
```

The aggregate evidence is written to:

```text
logs/release-gate-e2e/release-e2e-gate.json
logs/release-gate-e2e/release-e2e-gate.md
```

## Required Cases
- `e2e:release-plan-mode-lifecycle`
- `e2e:release-plan-mode-ux`
- `e2e:release-cli-long-session`

## Plan Mode Lifecycle
This case validates:

- normal session enters draft only through send-time planning action
- draft can request input and finalize a plan
- approval activates execution
- Todo loop constrains execution
- completion exits execution state
- cancel paths do not corrupt plan state

## Plan Mode UX
This case validates:

- approval card rendering
- Plan input rendering
- observe-only state when CLI owns an active run
- disabled Web mutations during observe-only
- stale interrupted or canceled cards are not shown as current after a new run

## CLI Long Session
This case validates:

- public CLI exec path
- JSONL event persistence
- source headers and session ids
- LLM selection and plan-mode flag propagation
- external MCP config
- Web/CLI session-source isolation
- 20 sequential CLI rounds

## Evidence Rules
The aggregate JSON must record the current source commit SHA and required case
ids. Missing, stale, failed, or mismatched evidence blocks publish.

## Failure Handling
Treat failures as product or protocol failures, not as publish-script issues,
unless the evidence clearly points to script wiring. Fix the root cause and
rerun `npm run test:release-e2e` or the full source gate as appropriate.
