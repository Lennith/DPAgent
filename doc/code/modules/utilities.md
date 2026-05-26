# Utilities

## Responsibility
Utility modules provide shared infrastructure not owned by any single feature
module: structured logging with level/component filtering and file rotation, and
workflow text analysis for command extraction and fingerprint generation.

## Source Paths
- `src/utils/`

## Key Files
- `src/utils/logger.ts`: unified `Logger` class with configurable log levels
  (`DEBUG < INFO < WARN < ERROR`), component tagging (`WebServer`, `DPAgent`,
  `Agent`, `LLM`, `Tool`, `MCP`, `Skill`, `Session`, `Config`), dual
  file+console output, and automatic log directory creation. Includes
  `sanitizeForLog()` which redacts API keys, passwords, secrets, and tokens and
  truncates long content/prompt fields.
- `src/utils/workflow-signal.ts`: text analysis utilities for workflow-aware
  features. Provides `tokenizeWorkflowText()` for stopword-filtered token
  extraction, `extractCommandCandidates()` for CLI command detection via
  backtick-fenced blocks and npm/powershell/git prefix matching,
  `extractChecklistItems()` for numbered/bulleted checklist parsing,
  `looksLikeFailure()` for error keyword detection (including Chinese),
  `slugifyWorkflowText()` for readable slug generation, and
  `buildPromptFingerprint()` for stable prompt fingerprinting from tokens and
  commands.

## Runtime Contracts
Logger is globally instantiated per component with configurable minimum level.
Redaction rules apply to all structured payloads before writing. Workflow
signal utilities are pure functions with no side effects or runtime state.

## Edit Guidance
- Add new `LogComponent` values to the `LogComponent` union type and update any
  routing that depends on component filtering.
- Keep redaction rules in `sanitizeForLog()` up to date with any new sensitive
  field naming conventions.
- Workflow signal regex patterns (`TOKEN_SPLIT_REGEX`, `COMMAND_LINE_REGEX`,
  `CHECKLIST_REGEX`) should be tested against representative real-world inputs
  before changes.
- Do not add runtime state or async I/O to `workflow-signal.ts`; keep it as
  pure utility functions.

## Closest Tests
- `tests/unit/slim-refactor-contract-manifest.test.ts` (workflow utilities)
- No dedicated logger test file exists; logger behavior is exercised
  indirectly through integration and e2e tests.
