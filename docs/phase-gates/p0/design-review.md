# P0 Design Review

- Date: 2026-04-12
- Reviewer: independent subagent `Mill`
- Validation round: rerun after fixing fixed-toolset boundary
- Verdict: PASS

## Goal

只读复验当前代码是否满足 `Windows-First Hermes port plan` 的 P0 边界与约束，重点核对 `memory_manage`、`session_search`、progressive skills、skill 审批流、`clarify`、named toolsets、Web 可见性，以及 fixed toolset 白名单约束。

## Scope

- 本次仅做静态审查，不写代码、不改文件。
- 重点检查了 `src/tools/ToolsetRegistry.ts`、`src/index.ts`、`src/tools/SubAgentManageTool.ts`、`src/skills/SkillLoader.ts`、`src/skills/SkillDraftStore.ts`、`src/memory/MemoryStore.ts`、`src/memory/SessionSearchIndex.ts`、`src/web/server/WebServer.ts`、`src/config/ConfigManager.ts`、`src/types.ts`、`src/web/client/components/chat/GovernancePanel.tsx`、`tests/unit/toolset-registry.test.ts`。

## Conclusion

当前实现满足 P0 目标，未发现阻断性的设计偏差。上一轮阻断项已经收敛：toolset 现在是固定白名单，未知工具不会再自动透传给主 agent 或子 agent。

## Findings

none

## Residual Risks

- progressive skill 的对外行为已经符合 P0，但 loader 在构建 catalog 时仍会把 skill 正文读入内存对象，而不是严格“命中后再读盘”；当前不会把正文注入系统提示，属于实现层面的余量，而不是 P0 阻断项。
- 新的默认配置已经落在代码里，但 `/api/config` 与 `/api/settings` 还没有完整暴露 `defaultToolset`、`memoryWriteMode`、`skillWriteMode`，配置可发现性不完整；这不阻断 P0 能力本身。

## Evidence

- P0 能力已落地并接入 turn registry：`memory_manage`、`session_search`、`skills_list`、`skills_view`、`skill_manage`、`clarify` 都在当前 turn 中按 toolset 注册。
- 系统提示只注入 toolset summary、persistent memory 和 skill catalog，不全量注入 skill 正文。
- toolset 已是固定白名单：三套默认 toolset 都显式 `allowUnknownTools: false`，并通过 `allowsTool` 做能力判断；对应拒绝未知工具的测试也已补上。
- 子 agent 边界保持兼容且不绕过白名单：父 turn 先按当前 toolset 过滤，再把过滤后的 tool list 传给 `subagent_manage`，子 agent 继续做交集约束。
- Windows-first 约束保持成立：默认 shell 仍是 PowerShell，本地 memory 和 session index 都基于 `fs/path`，未引入 WSL2、SQLite native、云依赖或外部 memory provider。
- Web 可见性与接口符合 P0：`/api/toolsets`、`/api/skills`、`/api/skills/pending`、`/api/memory`、`/api/memory/pending` 已提供，且前端有治理面板承接 toolset 切换和审批流。
- 公共配置名、默认值、审批策略与计划一致：`defaultToolset=windows-dev`、`memoryWriteMode=confirm`、`skillWriteMode=confirm` 已在默认配置和类型中定义。
