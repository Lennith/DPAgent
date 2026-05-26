# Scripts

## Responsibility
Scripts provide standalone CLI utilities for offline data transformation and
migration tasks. They are not part of the runtime agent loop but share tooling
with the core modules (storage, compression, LLM, config).

## Source Paths
- `src/scripts/`

## Key Files
- `src/scripts/convert-rollout.ts`: converts a Codex rollout JSONL file into
  DPAgent persisted session messages. Reads the rollout line-by-line, classifies
  records by type (message, reasoning/thinking, function_call), resolves the
  latest thinking block for each assistant message, and writes output via
  `JSONLWriter`. Depends on `ConfigManager`, `LLMClient`, `ContextCompressor`,
  and `storage/` primitives.

## Runtime Contracts
Scripts are run as one-shot CLI processes outside the agent and web server
lifecycle. They read from hardcoded or CLI-argument file paths and produce
output files. Scripts may require a valid `config.yaml` for API credentials and
model configuration when LLM calls are needed.

## Edit Guidance
- Keep script entry points in `src/scripts/`; do not import them from runtime
  or server code.
- When scripts need shared logic, prefer extracting it into `src/shared/` or
  the relevant domain module rather than duplicating.
- Document required input format and environment prerequisites in a comment
  block at the top of each script file.
- Update this doc when adding or removing scripts.

## Closest Tests
- No dedicated script tests exist. Script behavior is validated through manual
  execution against known rollout files.
