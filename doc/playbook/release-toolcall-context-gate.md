# Release Toolcall Context Gate

## Purpose
This gate verifies tool protocol continuity, context replay, long conversation
behavior, and manual material-correctness review across multiple provider
profiles.

## Command
```bash
npm run test:release-toolcall-context-session
```

## Maintained Profile Matrix
The release gate runs two active release profiles:

```text
deepseek
minimax
```

Each profile runs 10 tool-heavy rounds. The minimum pass rate is 90%, so each
profile must pass at least 9 of 10 rounds.

Model expectations:

- `deepseek`: `deepseek-v4-flash`
- `minimax`: `MiniMax-M2.7-highspeed`

Kimi is not part of the maintained release gate while no active release key is
available. Reintroduce it by adding the profile back to the package script and
the official release evidence expectations.

## Local Profile Files
Release profile files are local or environment-specific. Do not commit
credential-bearing profile files, and do not include them in npm packages.

The publish audit forbids:

```text
release-toolcall-profiles.dev.json
release-toolcall-profiles.local.json
```

## Evidence Files
The gate writes:

```text
logs/release-gate-toolcall-context-session/release-toolcall-context-gate.json
logs/release-gate-toolcall-context-session/release-toolcall-context-gate.md
logs/release-gate-toolcall-context-session/release-toolcall-context-manual-review.json
```

## Manual Review Requirements
The manual review JSON must include:

- reviewer
- reviewedAt
- reviewedCommitSha matching the aggregate source commit
- reviewed session ids
- required run count
- reviewed rounds per run: 10
- model field: `multi-profile`
- profile list
- checklist approvals for metrics, failure flags, field mismatches, history consistency, cascade failures, completion-marker repairs, and material correctness
- `seriousHallucinationFound: false`
- `scriptFalsePositivePassFound: false`
- `conclusion: "approved"`

Missing, incomplete, stale, or mismatched manual review evidence blocks publish.

## Source Gate Reuse Exception
Reuse is allowed only for release-process-only changes that cannot affect
runtime behavior, UI, automation, LLM protocol, package contents, or tests. The
manual review must explicitly set `sourceGateReuse.approved: true`, describe the
diff scope, list skipped commands, and bind the previous and current commit SHA.

## Failure Handling
Below-threshold profiles, mismatched model fields, stale commit SHA, or failed
manual review block release. Fix the cause and rerun the gate.
