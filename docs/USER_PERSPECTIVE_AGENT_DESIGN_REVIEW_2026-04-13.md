# 用户视角设计评审

日期: 2026-04-13  
范围: Web 前端界面、会话与工作区模型、子代理、预加载 AGENT、MCP 与运行时可靠性  
目标用户心智: 把系统当成一个可在多个工作区并行工作的 Agent 工具，体验接近 Codex

## 一句话结论

当前系统的主要问题不是“功能不够多”，而是“产品语义不稳定、运行时边界不清、界面反馈不够可信”。  
从代码现状看，它更像一个把很多高级能力堆到单聊天界面里的工程台，而不是一个边界清晰、可并行、可恢复、可审计的多工作区 Agent 工作台。

## 现状总结

当前系统已经具备这些强能力：

- 支持 session 级复用，避免每轮重建 Agent。
- 支持同目录多个 session 并发。
- 支持 subagent、workspace AGENTS、global AGENTS、toolset、skill、memory、auto-loop、plan input。
- 支持共享 MCP 连接，减少重复连接开销。
- 支持长会话 replay 与 compressed older-session context。

但这些能力在产品面存在四个核心断层：

- 用户看到的是“聊天 UI”，系统内部实际是“session + workspace + runtime + toolset + skill + subagent + auto-loop”的复合系统。
- 前端暴露的概念和后端真实对象不一致。
- 并行能力存在，但没有配套的可观察性、隔离性和恢复语义。
- 很多能力是“隐式生效”，不是“显式可理解”。

## 主要问题

### P0: 会话、工作区、运行时三者不是稳定的一等对象

- `workspace` 同时存在为 `ContextScope`、`session.meta.workspaceDir`、bootstrap 默认目录三套来源，边界不统一。
- 前端底部只显示一个全局 `Workspace` 文本，但发消息时直接取当前全局 `workspaceDir`，切 session 又会改写它。
- `/api/sessions` 和 `/api/sessions/:id` 仍主要依赖 bootstrap agent 的 context store，而 session runtime 会按 workspace 派生自己的上下文与运行时目录。

结果:

- 用户无法稳定回答“我现在在哪个 workspace 里工作”。
- 多工作区下，列表、详情、实际运行态可能出现错位。
- 这直接违背了类似 Codex 的 thread/workspace 心智。

关键证据:

- `src/web/client/App.tsx`
- `src/web/client/components/sidebar/Sidebar.tsx`
- `src/web/server/WebServer.ts`
- `src/index.ts`
- `src/types.ts`

### P0: 并行能力存在，但不是一个可管理的并行工作台

- 侧边栏只能看到某个 session 有小绿点在跑。
- 主区永远只展示当前 session 的消息和状态。
- 没有“所有运行中的任务”视图，没有跨 workspace/session 的运行总览，没有统一队列或恢复中心。

结果:

- 系统技术上支持并发，产品上却仍像单线程聊天窗。
- 用户难以把它当成“多个 Agent 同时工作的工具”，更像“一个聊天窗 + 若干后台黑盒”。

关键证据:

- `src/web/client/components/sidebar/Sidebar.tsx`
- `src/web/client/App.tsx`
- `src/web/client/components/subagent/SubAgentPanel.tsx`

### P0: 可靠性反馈不够真实，部分状态还是“伪进度”

- MCP 在 UI 上只有一个灯和一句汇总文案，看不到哪台 server 出错、是否重连中、失败原因是什么。
- 聊天区 ETA 使用固定 30 秒估算，不是基于真实任务数据。
- SubAgentPanel 中的 `analyze/plan/execute/review/finalize` 阶段是按时间轮转的伪 phase，不是真实后端状态。
- 取消、卡住、取消中、取消已确认的状态区分不清。

结果:

- 用户无法判断系统到底是真的在工作，还是只是“正在展示一个看起来合理的状态”。
- 这会直接损伤“可靠工具”的信任基础。

关键证据:

- `src/web/client/mcp-status.ts`
- `src/web/client/components/chat/ChatContainer.tsx`
- `src/web/client/components/subagent/SubAgentPanel.tsx`
- `src/web/client/hooks/useWebSocket.ts`

### P0: 断线恢复和长任务续跑语义明显不足

- WebSocket 断开时，plan input 与 continuation 会直接被 reject 或取消。
- `chat_resume` 被明确禁用。
- 某些取消路径在没有精确 context 时会升级为 `cancelAllRuns()`。

结果:

- 刷新页面、切标签、网络抖动后，用户无法确信长任务还能继续。
- 在并行多会话工具里，这种“连接即运行时”的耦合过强。

关键证据:

- `src/web/server/WebServer.ts`

### P1: 预加载 AGENT / @agent / 子代理 / provider 不是同一套产品语义

- 主聊天中的 `@agent` 主要是 prompt 注入和 session 元数据记忆，不是 first-class runtime/profile 绑定。
- 主聊天可见 agent 集、workspace AGENTS 自动注入集、subagent 可选 agent 集并不一致。
- subagent 的 `agent` 与 `provider` 也是两套概念，但在用户心智上会被误认为同一件事。

结果:

- 用户会误解“我是在切换 agent”，但系统实际更像“注入 persona + 继续在同一 session 上跑”。
- 用户会误解“agent 列表就是所有当前可用 agent”，但不同路径规则不同。

关键证据:

- `src/web/client/components/chat/ChatInput.tsx`
- `src/web/server/prompt-resolution.ts`
- `src/agents/AgentProfiles.ts`
- `src/subagent/SubAgentManager.ts`
- `src/subagent/SubAgentTurnRunner.ts`

### P1: 同目录多 session 并发的隔离还不够硬

- 现在允许同目录多个 session 并发，但 runtimeDataDir/contextDir 默认仍落在 workspace 级目录。
- 同目录多 session 可能共享 memory/index、subagent registry 等运行时副产物。
- 子代理的上下文连续性保护只部分生效，强并发场景下反而更容易绕过。

结果:

- “共享代码目录”与“共享运行时状态”混在一起。
- 用户会以为只有文件会共享，实际上部分内部状态也可能串味。

关键证据:

- `src/index.ts`
- `src/web/server/WebServer.ts`
- `src/subagent/SubAgentManager.ts`

### P1: 存储与上下文耐久性模型偏脆弱

- `ContextEventStore` 采用同步整文件读写与进程内锁。
- 读到坏行时直接忽略。
- 长会话场景下性能和完整性都缺少更强保护。

结果:

- 会话越长越慢。
- 极端情况下可能出现“历史退化但不明确报警”的问题。

关键证据:

- `src/context/ContextEventStore.ts`

## 冗余设计与设计债

### 1. 前端概念多，真正可见入口少

- 存在 `toolset / preset / skill / skill pack / memory / audit / auto-loop / subagent / AGENT profile` 多套概念。
- 但主界面多数时候只显露聊天、会话列表、一个 MCP 灯、一个子代理侧栏。
- 结果是系统复杂度已经很高，用户感知到的却是“很多不稳定的暗门”。

### 2. 有完整治理面板实现，但没有进入主流程

- `GovernancePanel.tsx` 包含 toolset、preset、todo、skill pack、memory trigger 等完整治理 UI。
- 当前并未接入主界面渲染。

结果:

- 一方面保留了大量治理代码与状态接口。
- 另一方面主界面仍缺乏真正可见的工作区/能力治理入口。

### 3. 主界面职责过重

- `App.tsx` 负责 WebSocket、session 状态、消息拼装、runtime watchdog、MCP 轮询、workspace 切换、plan input、subagent panel 开关等。
- 这会让“前端状态就是产品语义”的问题越来越难收敛。

### 4. 多套隐式默认值

- toolset 默认来源存在隐式写入。
- workspace profile、global profiles、selected agent、mentioned agent 叠加规则较多。
- 用户很难知道某次能力变化到底来自配置、目录、会话历史还是 prompt。

## 明显不符合设计目标的点

如果目标是“一个像 Codex 的、可靠的、多工作区 Agent 工具”，当前最明显不符合的是：

- `workspace` 不是一等对象。
- `session` 不是稳定线程，而更像“挂了很多隐式状态的聊天记录”。
- 并行运行没有统一总览和恢复语义。
- 子代理不是清晰的 child run，而更像全局任务旁路回写。
- AGENT 选择不是显式模式切换，而更像 prompt 魔法。
- 状态反馈有伪进度和信息压缩过度的问题。

## 优先改进建议

### 第一优先级: 先统一对象模型

- 明确 `workspace`、`session/thread`、`agent profile`、`subagent run` 四个一等对象。
- 前端和后端统一用同一套主键与归属关系，不再混用“全局默认值 + session 字段 + runtime 推导”。

### 第二优先级: 把并行能力做成真正的工作台

- 增加“运行中任务总览”。
- 增加按 workspace/session 聚合的运行状态、错误、等待用户输入、子代理状态视图。
- 让用户能比较和切换多个并行 run，而不是只能盯当前聊天窗。

### 第三优先级: 去掉伪状态，换成真实状态

- 子代理 phase 只显示真实后端状态。
- ETA 只在有真实估算依据时显示。
- MCP 状态展开到 server 级，并展示失败原因与重连状态。
- 长任务状态区分为运行中、等待工具、等待用户输入、取消中、已取消、失败。

### 第四优先级: 显式化 AGENT 与权限边界

- 让 AGENT 选择成为显式 UI，而不是主要依赖 `@agent`。
- 分清楚“切换当前 session 角色”“委派子代理”“加载 workspace AGENTS”三件事。
- toolset 默认来源和覆盖链必须可见。

### 第五优先级: 补齐恢复与隔离

- 断线后可重连查看活跃 run。
- 取消默认只作用当前 context。
- 同目录多 session 只共享代码目录，不共享不必要的运行时副产物。

## 总评

从工程角度看，这个系统已经有很多接近主流 agent 平台的底层能力。  
从用户体验角度看，它还没有收敛成一个“边界清晰、可信、稳定”的产品。

当前最大的设计债不是缺少某一个按钮，而是：

- 对象模型没有真正产品化
- 能力是拼上去的，不是按用户心智组织的
- 并行和可靠性是“部分具备”，不是“完整成立”

如果继续在现有界面上直接叠加功能，复杂度还会继续上升，用户对稳定性的主观感受反而会下降。
