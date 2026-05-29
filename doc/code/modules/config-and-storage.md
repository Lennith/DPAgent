# Config And Storage

## Responsibility
Config and storage modules load runtime configuration, resolve public settings,
persist JSON/JSONL state, and provide atomic local storage primitives.

## Source Paths
- `src/config/`
- `src/storage/`
- `src/shared/`
- `src/runtime/context-window-budget.ts`
- `src/runtime/context-usage-calibration-store.ts`
- `src/runtime/async-primitives.ts`
- `CONFIG.md`

## Key Files
- `src/config/ConfigManager.ts`: YAML, environment, provider profile, toolset, auth, and path resolution.
- `src/storage/`: atomic JSON/JSONL helpers and persistence primitives.
- `src/shared/context-token-estimation.ts`: weighted token estimation from strings and payloads, delta token calculation for streaming append-only updates, and token↔char hint conversions.
- `src/shared/remote-access-auth-defaults.ts`: remote access authentication defaults (session TTL, TTL options, enabled/trustProxy flags).
- `src/shared/web-settings-contracts.ts`: TypeScript contract types for public settings views (LLM profiles, context budget, agent config, remote access auth) and settings mutation request shapes.
- `src/runtime/context-window-budget.ts`: resolved context budget calculation.
- `src/runtime/context-usage-calibration-store.ts`: context usage calibration persistence.
- `src/runtime/async-primitives.ts`: shared async helpers.
- `src/web/server/config-mutation-service.ts`: transactional Web settings mutation.
- `CONFIG.md`: user-facing config reference.

## Runtime Contracts
Configuration defaults have one runtime source. UI defaults, CLI templates, and
server public views must derive from resolved configuration. Runtime artifacts
and local credentials are never source or package artifacts.

The shipped LLM configuration is setup-first. `llmProfiles` may be empty, and
runtime LLM resolution fails with a configuration error until the user creates a
provider profile with API base, model, and credentials. Templates and first-run
config generation must not inject a vendor-specific executable profile.

## Edit Guidance
- Keep config validation near `ConfigManager`.
- Use storage primitives rather than ad hoc file writes for runtime state.
- Roll back settings mutations on failed persistence or view refresh.
- Update [local config and profile hygiene](../../playbook/local-config-profile-hygiene.md) when local-only file rules change.

## Closest Tests
- `tests/unit/web-config-provider.test.ts`
- `tests/unit/web-config-modal-ui.test.ts`
- `tests/unit/web-llm-profile-routes.test.ts`
- `tests/unit/package-release-sanitized-config.test.ts`
- `tests/unit/workspace-preferences.test.ts`
