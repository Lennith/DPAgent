# MiniMax Agent 当前设计说明

## 1. 设计目标

当前版本的设计目标不是“做一个最大而全的 Agent 平台”，而是把下面几件事做稳定：

- 让单轮 Agent 执行可靠
- 让长会话上下文可持续
- 让长期 memory 能自动沉淀，但不破坏主链
- 让 skill 保持治理能力
- 让多 session 并发时的数据一致性可控
- 让 Web UI 能把这些能力直观暴露出来

## 2. 设计原则

## 2.1 事件流优先

上下文的单一事实来源是 `contexts/.../events.jsonl`，而不是拼出来的缓存消息文件。

这样做的好处：

- turn 生命周期完整
- 工具调用可审计
- projection 可重建
- 后续压缩、检索、治理都能建立在稳定事件流上

## 2.2 context、memory、skill 分层

这是当前系统最关键的设计边界。

### context

负责当前工作连续性：

- 本轮输入输出
- 最近几轮 replay
- 更早历史的 compressed older-session context
- 结构化 patch

### memory

负责长期事实：

- 用户偏好
- 项目约定
- 稳定 workflow
- 长期有效命令和 workaround

### skill

负责方法沉淀：

- 一类操作应该怎么做
- 一个流程如何标准化复用

如果把这三者混在一起，会带来两个问题：

- prompt 变重
- 系统边界模糊，导致“该回忆、该搜索、该沉淀”都不清楚

## 3. 上下文设计

## 3.1 为什么要拆成 snapshot + replay + compressed context

以前常见的问题是：

- 最近对话既出现在 system prompt，又出现在 replay messages
- 历史摘要链不止一条
- 内部压缩 marker 也可能混入后续上下文

当前设计把它们收敛为：

- `Context Snapshot`
  只承载结构化上下文
- `replayMessages`
  只承载最近几轮会话连续性视图
- `compressed older-session context`
  只承载更早历史的单一摘要链

这解决了两个核心问题：

- 近端上下文重复注入
- 摘要链并存导致的心智负担和 token 浪费

## 3.2 为什么保留 compressed older-session context

如果只保留 recent replay，长会话一旦超过窗口，旧信息就会完全断掉。  
如果把全部旧内容都放回 prompt，成本又太高。

这里的 recent replay 仍然是 runtime prompt 用的连续性视图，不等于 `session_search` 所索引的 raw transcript excerpt。

所以 compressed older-session context 的作用是：

- 给模型一个稳定的“更早发生过什么”的摘要入口
- 但不挤占 recent replay 的会话连续性空间

## 3.3 Prompt 约束

当前设计要求把 prompt 里的信息分成两类：

- `system prompt`
  只承载稳定运行约束、模式约束和结构化快照
- `user prompt`
  只承载用户本轮任务，以及必要的 agent/profile 选择信息

这里的关键约束是：

- `toolset summary` 只说明当前可调用的是哪套工具，以及调用边界是否开启
- 不在 `toolset summary` 里重复展开 `memory_manage`、`session_search` 这类工具的操作手册
- `context_manage`、`session_search`、`memory_manage` 的边界应尽量下沉到工具 description 和参数语义中
- system prompt 里如果保留 context / session recall / memory 路由规则，也应保持极短，只做高层分流，不再承载细节清单

这样做的目的，是把“运行时总规则”和“某个工具具体怎么用”分开，避免 system prompt 逐步膨胀成工具说明书。

## 3.4 Agent Profile 注入契约

`AGENTS.md` 和其他 agent profile 的定位，不是 system prompt 的一部分，而是 prompt shaping 层的 agent 选择信息。

目标契约如下：

- workspace `AGENTS.md` 默认只在 session 首轮注入一次
- 显式 `@agent` 或显式 agent 切换时，再注入一轮新的 agent/profile
- 如果后续 turn 没有切换 agent，就继续沿用当前 active agent，不重复注入
- `agentInjectionState` 应作为 active agent 的会话态，而不是只写不读的审计痕迹
- `AGENTS.md` 正文不进入 system prompt
- 如需保留 profile 信息，应停留在 user prompt shaping 侧，而不是在 LLM 每一步执行前重复展开
- 历史 replay 不应重复带入 `AGENT_PROFILE_REF` 或 profile 正文

这个约束的核心目标是两点：

- 避免 agent/profile 信息在每轮、每 step 重复放大
- 避免 profile 正文污染 system prompt，导致 system 指令和 workspace 业务规则耦合

## 3.5 当前实现偏差（待对齐）

截至当前版本，代码实现与上面的目标契约仍存在差异：

- workspace profile 仍然会在每次 turn 解析时重新注入 ref
- `AGENTS.md` 正文仍会在运行时被读出并拼入 system prompt
- `agentInjectionState` 目前主要用于记录，不参与“后续是否继续注入”的真实判定
- `context_manage` / `session_search` / `memory_manage` 的高层分流已经进入默认和 turn 级 prompt，但具体语义仍应以工具 description 与参数契约为准

因此，当前文档中的这部分内容应视为设计基线，而不是已经完全落地的现状描述。

## 4. memory 设计

## 4.1 为什么 memory 不再审批

memory 和 skill 最大不同在于：

- skill 是方法资产，审批有价值
- memory 是事实沉淀，如果每次都审批，主链会被卡住

所以当前选择是：

- memory 自动 organize
- skill 保留审批

这样能把“事实沉淀”从主链上移出去，但不取消“方法治理”。

## 4.2 为什么采用异步 organize，而不是每轮同步晋升

如果每轮结束都同步做 memory 提取，会带来三个问题：

- 尾延迟变大
- 主链和 memory 写入耦合
- 多 session 时更容易出现竞态

因此当前采用：

- 3 turn 批处理
- 2 分钟空闲补刷
- 手动 organize

这是一种折中：

- 不是实时
- 但也不至于长期积压

## 4.3 为什么要按 workspace 串行

memory 的危险点不在“单次写入”，而在“多会话并发写同一个事实域”。

如果不串行，就会出现：

- 两个 session 同时写同一 workflow
- lineage 版本错乱
- 重复 entry
- 冲突检查基于旧快照

所以现在统一规则是：

- 同一 workspace 的 memory mutation 串行
- 不同 workspace 可以并行
- user scope 也走独立串行 key

## 4.4 为什么 memory 仍然保留版本链

长期事实会变化，例如：

- 发布流程增加了一步
- 命令参数变了
- 约定更新了

所以 memory 不是简单覆盖，而是：

- active
- superseded
- expired

这允许系统既保留当前事实，也保留历史链。

## 4.5 为什么 session search 不能被 memory 替代

很多“之前聊过什么”的问题，属于会话历史回忆，而不是长期事实。

例如：

- 上周临时试过哪个 workaround
- 上一轮 debug 输出里哪个日志最关键
- 某个 session 里到底讨论到哪一步

这些信息更适合 session search，而不是长期 memory。

## 4.6 为什么 context_manage 不能被 session_search 替代

`session_search` 找的是 raw session transcript excerpt。  
它擅长回答“之前聊过什么”，但不擅长回答“当前有效 context state 是什么”。

当前有效 context state 可能包含：

- committed structured context
- 当前 turn 里的 pending overlay
- selected runtime context state，例如 `compressedHistoryContext`

这些都应该通过 `context_manage` 查看，而不是通过 `session_search` 或 `memory_manage` 曲线读取。

## 5. skill 设计

## 5.1 为什么 skill 还保留审批

skill 最终会影响：

- 之后 agent 的行为偏好
- 可复用方法目录
- pack 资产

所以 skill 仍然保留：

- draft
- 审批
- 历史
- 回滚

它的治理门槛应当高于 memory。

## 5.2 为什么 skill 和 memory 不能互相复制

一个 workflow 可能同时产生：

- 一条 workspace memory
- 一个 skill draft

但二者应该分工不同：

- memory：提炼事实
- skill：提炼方法

否则会产生重复和混乱。

## 6. toolset 设计

## 6.1 为什么需要 capability 白名单

Agent 的风险不只来自模型能力，也来自工具暴露范围。

toolset 的设计目的，是把“能看到什么工具”做成显式边界。

这样可以让：

- 默认模式偏安全
- 研究模式打开 web 工具
- 某些 session 暂时只读

## 6.2 为什么要做 capability 级去重

同一种能力可能同时来自：

- core tool
- MCP tool
- 团队工具

如果不做 dedupe，会出现：

- 同类工具重复暴露
- 模型选择不稳定
- 运行期行为飘忽

所以当前用 capability family 做收口。

## 7. 子代理设计

## 7.1 为什么子代理不是直接共享主 Agent 执行循环

如果完全复用主 Agent 的消息状态，会导致：

- 生命周期混淆
- 上下文污染
- 并发难以管理

所以当前设计是：

- 子代理任务由 manager 管
- 单次执行由 turn runner 管
- 父会话只接收索引和结果写回

## 7.2 为什么子代理保留单独的治理和状态

这样 Web UI 才能稳定展示：

- queued
- running
- succeeded
- failed
- canceled
- timeout

而不是把子代理执行混在主对话文本里。

## 8. Web 设计

## 8.1 为什么 memory organize 做成轻量按钮

它应该是“当前 session 的局部动作”，不是全局治理操作。

所以它放在聊天输入区附近，而不是当成全局设置。

这让用户的心理模型更清楚：

- 我现在整理的是当前会话的 backlog
- 不是全局把所有 memory 重跑一遍

## 8.2 为什么治理面板保留审计，但不再承接 memory 审批

因为 memory 已经从审批流切到整理流。  
治理面板更适合作为：

- 审计结果展示
- skill 治理入口
- backlog 观测视图

## 9. 当前设计的主要权衡

## 9.1 优点

- 边界比旧版本清楚
- memory 不再阻塞主链
- 长会话成本更可控
- 多 session 并发时一致性更强
- UI 对运行状态的反馈更直观

## 9.2 代价

- 系统模块较多
- context / memory / skill / session search 需要明确区分
- 历史 phase 文档仍然存在，阅读时需要区分“当前契约”和“历史记录”
- 个别实现残留仍在清理中，例如 `ToolsetRegistry` 的内置 capability 列表里还保留了历史 `note` 标记，但对应工具已经不在 live path

## 10. 当前非目标

当前版本没有把这些作为主目标：

- 把 memory 变成全文语义数据库
- 让 skill 自动完全无审查发布
- 把全部历史消息直接塞回 prompt
- 用一个统一对象代替 context、memory、skill 三层

## 11. 一句话总结

当前系统的设计核心是：

- 用 `context` 保证连续性
- 用 `memory` 沉淀长期事实
- 用 `skill` 沉淀可复用方法
- 用 `toolset` 和治理机制控制边界

这是一个分层设计，而不是把所有信息都塞进同一个“记忆”桶里。
