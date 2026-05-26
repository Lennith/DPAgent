# Specification Index

Specification documents define technical design, architecture, module
interaction, invariants, and protocol contracts.

Specs may reference source modules, but detailed file ownership and edit points
belong in [code module docs](../code/README.md).

## Architecture And Flow
- [Architecture baseline](architecture-baseline.md)
- [Module flow baseline](module-flow-baseline.md)
- [Agent profile baseline](agent-profile-baseline.md)

## Protocols
- [Web session ownership protocol](protocols/web-session-ownership-protocol.md)
- [WebSocket runtime event protocol](protocols/websocket-runtime-event-protocol.md)
- [Plan Mode backend lifecycle](protocols/plan-mode-backend-lifecycle.md)
- [Pending Plan input lifecycle](protocols/pending-plan-input-lifecycle.md)
- [Auto-loop and continuation protocol](protocols/auto-loop-todo-continuation-protocol.md)
- [Interrupted run recovery protocol](protocols/interrupted-turn-recovery-protocol.md)

## Boundary
- Put state-machine, DTO, event, and lifecycle contracts here.
- Put user-facing flows in [design](../design/README.md).
- Put source maps and edit guidance in [code](../code/README.md).
