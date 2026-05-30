# Design Index

Design documents define feature behavior. They bridge PRD and technical spec by
describing user flows, UX states, business rules, and acceptance checks.

Design docs can mention state names such as `plan_drafting` when those names are
part of the product model, but exact server DTOs, WebSocket events, and source
paths belong in spec/protocol and code docs.

## Feature Designs
- [Plan Mode lifecycle](features/plan-mode-lifecycle.md)
- [Plan input and finalization](features/plan-input-and-finalize-plan.md)
- [Composer next-turn controls](features/web-composer-next-turn-controls.md)
- [Session origin and observe-only](features/session-origin-observe-only.md)
- [Run interruption and error cards](features/run-interruption-and-error-card-lifecycle.md)
- [Ralph, Todo, and Plan execution](features/ralph-todo-plan-execution.md)
- [Arena](features/arena.md)
- [GLM ASR module](features/glm-asr-module.md)
- [Hook system](features/hook-system.md)

## Boundary
- Put user-facing behavior and UX expectations here.
- Put product goals in [PRD](../prd/README.md).
- Put exact protocol contracts in [spec/protocols](../spec/README.md).
- Put file ownership and edit points in [code](../code/README.md).
