# Runtime Facade And CLI

## Responsibility
The runtime facade wires the core services together. CLI modules provide public
entrypoints, config initialization, Web startup, and CLI-driven execution.

## Source Paths
- `src/index.ts`
- `src/dpagent-runtime.ts`
- `src/cli/`
- `src/runtime/dpagent-bootstrap.ts`
- `src/runtime/dpagent-core-services.ts`
- `start.js`
- `start-easy.js`
- `init.js`
- `setup.js`

## Key Files
- `src/index.ts`: public package facade and root export surface.
- `src/dpagent-runtime.ts`: `DPAgent` implementation and shared service construction.
- `src/runtime/dpagent-bootstrap.ts`: bootstrap helpers for facade startup.
- `src/runtime/dpagent-core-services.ts`: shared core service construction.
- `src/cli/dpagent.ts`: installed package command entrypoint.
- `src/cli/dpagent-exec.ts`: CLI execution path and WebSocket source headers.
- `start-easy.js`: Windows easy-run startup.
- `init.js` and `setup.js`: first-run local config scaffolding.

## Runtime Contracts
The facade owns service composition, not business logic that belongs to Agent,
Context, Web, or tools. CLI-origin runs must identify themselves through server
connection metadata and must not rely on request-body spoofing.

## Edit Guidance
- Put cross-service construction in `src/dpagent-runtime.ts`; keep `src/index.ts` as a thin package facade.
- Put CLI argument parsing and process startup in `src/cli/`.
- Do not add provider, tool, or context policy directly to CLI entrypoints.
- Keep package startup aligned with [internal npm publish](../../playbook/internal-npm-publish.md).

## Closest Tests
- `tests/e2e/release-cli-long-session.e2e.ts`
- `tests/unit/package-release-sanitized-config.test.ts`
- `tests/unit/private-npm-standard.test.ts`
