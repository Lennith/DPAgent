# Agent Runtime

## Responsibility
The Agent runtime executes one model turn. It prepares provider input, streams
output, executes tool calls, records usage, handles recovery, and stops only at
a valid terminal state.

## Source Paths
- `src/agent/`
- `src/runtime/dpagent-execution-tools.ts`
- `src/runtime/tool-result-payload-policy.ts`
- `src/runtime/interrupted-turn-lifecycle.ts`
- `src/interrupted-turn-recovery.ts`

## Key Files
- `src/agent/Agent.ts`: central step loop and tool/model coordination.
- `src/runtime/dpagent-execution-tools.ts`: per-run tool registry gating.
- `src/runtime/tool-result-payload-policy.ts`: artifact and payload sizing policy.
- `src/interrupted-turn-recovery.ts`: recovery prompt and interrupted replay handling.
- `src/runtime/interrupted-turn-lifecycle.ts`: interrupted artifact lifecycle helpers.

## Runtime Contracts
Agent consumes prepared replay and context state; it does not own durable event
storage. It must represent tool results, recovery messages, and terminal
failures explicitly instead of inferring success from partial output.

## Edit Guidance
- Keep the live loop centralized when compression, tools, and recovery mutate the same step state.
- Move pure helpers into narrow `src/runtime/*` files only when they have stable inputs and no hidden loop state.
- Do not put provider-specific repair logic in Agent; provider adapters own wire validation.
- Update [interrupted run recovery protocol](../../spec/protocols/interrupted-turn-recovery-protocol.md) when recovery semantics change.

## Closest Tests
- `tests/unit/agent-finish-reason-gating.test.ts`
- `tests/unit/context-overflow-recovery.test.ts`
- `tests/unit/web-interrupted-artifact-ui.test.ts`
- `tests/unit/execution-tool-registry-gating.test.ts`
