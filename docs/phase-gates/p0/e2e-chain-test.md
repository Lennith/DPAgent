# P0 End-to-End Chain Test

- Date: 2026-04-12
- Reviewer: independent subagent `Kierkegaard`
- Validation round: rerun after fixing fixed-toolset boundary
- Verdict: PASS

## Goal

独立复验 P0 真实链路，证明 `context / memory / skill / toolset / unknown-probe` 都是通过真实 `MiniMaxAgent.runWithResult` 触发、持久化、再次读取而闭合。所有运行都在 `%TEMP%` 临时 workspace/runtime 中完成，没有修改任何 repo-tracked 文件。

## Scope

- 入口使用真实 `MiniMaxAgent` + 真实 `ToolRegistry` + 临时 workspace/runtime/context。
- 验证 `context_manage` 与 `session_search` 的职责边界，以及 `memory_manage` 的 durable memory 链路。
- 验证 `skill draft -> approve -> skills_list / skills_view 生效`。
- 验证 `windows-safe` 与 `research` 的工具暴露差异会真实影响结果。
- 验证未知工具 `experimental_magic_probe` 不会因为 toolset 放宽而自动出现。

## User Stories Exercised

- `context`: 通过 `context_manage` 查看/修改当前 structured context state。
- `memory`: 先触发 pending suggestion，后通过 `memory_manage approve` 落盘，再由 `memory_manage` 自身读取验证 durable memory。
- `skill`: 先 `skill_manage create` 生成 draft，再 `skill_manage approve` 写入 workspace，随后 `skills_list` 可见、`skills_view` 可读正文。
- `toolset`: `windows-safe` 下 `shell_execute` 被阻断，`research` 下同一命令真实执行并返回 `toolset-ok`。
- `unknown tool`: `experimental_magic_probe` 在 `windows-dev` 和 `research` 下都保持 `Unknown tool`。

## Conclusion

P0 真实链路复验通过。

## Blocking Issues

none

## Evidence of Invocation

- `memory` 触发后生成 pending id `mem-pending-1775985944018-7b9910bc`。
- `context_manage` 被真实调用，用于 inspect/patch 当前 context state。
- `memory_manage approve` 被真实调用，且工具返回 `status: approved`。
- `session_search` 被真实调用，用于 prior session transcript recall。
- `skill_manage create` 被真实调用，draft id 为 `skill-draft-1775985944043-89d43fa5`。
- `skill_manage approve` 被真实调用，且工具返回 `status: approved`。
- `skills_list` 与 `skills_view` 都被真实调用，目标 skill 为 `p0-windows-build-command`。
- `shell_execute` 被真实调用于 `windows-safe` 和 `research`。
- `experimental_magic_probe` 被真实调用于 `windows-dev` 和 `research`。

## Evidence of Effectiveness

- `context`：`context_manage` 返回当前 namespace 的 structured state 和有效摘要视图。
- `memory`：`memory_manage` 返回 approved durable memory，内容里包含 `npm run build:web`。
- `skill`：`skills_list` 返回 `reviewStatus: "approved"`；`skills_view` 返回正文，包含 `Use \`npm run build:web\` before publishing the workspace.`；审批后 workspace 下 skill 文件已存在。
- `toolset`：`windows-safe` 返回 `Unknown tool: shell_execute`；`research` 成功执行 `Write-Output toolset-ok` 并返回 `toolset-ok`。
- `unknown tool`：`experimental_magic_probe` 在 `windows-dev` 和 `research` 下都返回 `Unknown tool: experimental_magic_probe`。
- toolset filter 结果也一致：`windows-safe=[]`，`windows-dev=['shell_execute']`，`research=['shell_execute','SearchWeb','FetchURL']`，probe 在两者下都被拒绝。

## Residual Risks

- 这次复验使用的是 scripted LLM stub，不是线上模型。
- 没有跑浏览器/WebSocket UI 流程，只验证了 Node/CLI 真实链路。
- `research` 里的 web 工具仅验证了可见性/过滤结果，没有额外做真实网络搜索/抓取调用。
