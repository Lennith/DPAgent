# P0 Functional Test

- Date: 2026-04-12
- Reviewer: independent subagent `Copernicus`
- Validation round: rerun after fixing fixed-toolset boundary
- Verdict: PASS

## Goal

独立复验 P0 功能是否可用，重点确认 `context_manage`、`memory_manage`、`session_search`、`skills_list/skills_view`、skill 审批队列、`clarify`、named toolsets、Web API，以及“未知工具不能被 `windows-dev` / `research` 自动透传”。

## Scope

- 仅做只读测试，不修改任何 repo-tracked 文件。
- 使用现有单测/集成测试、临时 runtime、临时 HTTP smoke、直接工具探针。
- 覆盖回归面：`context_manage`、`subagent`、Windows shell、Web chat。
- 覆盖 toolset 边界：`windows-dev`、`windows-safe`、`research`，并验证未知工具被拒绝。

## Test Matrix

- `npm test`
- 全量 unit 回归，包含 `test:subagent`、`test:web-chat-message`、`test:shell-tool`、`test:toolset-registry`、`test:memory-store`、`test:skill-loader-progressive`、`test:p0-session-transcript-search`
- 临时 HTTP smoke
  - `/api/toolsets`
  - `/api/memory`
  - `/api/memory/pending`
  - `/api/skills`
  - `/api/skills/pending`
  - `/api/sessions/:id/toolset`
  - memory / skill 的 approve / reject
- 直接工具探针
  - `clarify`
  - `context_manage`
  - `memory_manage`
  - `skills_list` / `skills_view`
  - `session_search`
- Toolset 边界探针
  - `windows-dev` / `research` 不放行未知 `tool:*`
  - `windows-safe` 不放行 `shell_execute`
  - `research` 放行 `shell_execute` 和 `SearchWeb`

## Conclusion

P0 功能复验通过。

## Failures

none

## Passed Evidence

- `npm test` 退出码为 `0`，整条回归链通过。
- 临时 HTTP smoke 成功，且返回了 `windows-dev`、`windows-safe`、`research` 三个 toolset。
- `context_manage` 验证了当前 structured context state 的 inspect / patch 基本路径。
- `memory_manage` 验证了 durable memory 的 `write / list_pending / approve / reject / read / delete` 关键路径。
- `skill_manage` 验证了 `create / list_pending / approve / reject`，且批准后的 skill 能被 `/api/skills` 和 `skills_view` 看到。
- `session_search` 的当前职责是 raw session transcript recall，不再混入 durable memory。
- `clarify` 工具探针返回了预期答案结构。
- 未知工具在 `windows-dev` 和 `research` 下都被 `filterTools()` 拒绝，没有被自动透传。
- 本次仅使用临时目录与运行时数据，没有新增 repo-tracked 改动。

## Residual Risks

- 这次 smoke 走的是本地 HTTP + 临时 runtime，不是浏览器 UI 会话。
- `session_search` 更复杂的长会话 raw transcript 检索链路由现有 `npm test` 里的 `test:p0-session-transcript-search` 覆盖。
- `skills` / `memory` 的 pending 列表是倒序返回，消费方不能假定首项就是目标项。
