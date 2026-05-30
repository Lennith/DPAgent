# DPAgent Release Notes: 2.0.1 -> 2.2.10

这份记录面向普通使用者和部署者，概括从 2.0.1 到 2.2.10 的主要变化。旧的 MiniMax Agent 运行时在这一段逐步收敛为 DPAgent：一个可以在本机、局域网、手机端和分享链接中使用的 Agent runtime。

## 主要变化

### 产品与安装

- 包名和运行时统一为 `@dpvr/dpagent` / `dpagent`。
- 默认启动入口是 `npx dpagent`，启动后打开 Web 前端。
- npm 包增加更严格的发布校验：前端构建、打包内容审计、安装 smoke、release e2e 和工具调用上下文 gate。
- 2.2.7 起，用户指南会随 npm 包发布，并可通过服务端 HTML 页面访问：`/guide/user-guide`。

### Web 前端

- 新增会话列表、会话恢复、运行状态、取消、计划模式、Ralph 循环、LLM 选择、模型推理挡位等常用控制。
- 支持运行中追加输入队列，避免正在执行时直接丢输入。
- 支持消息中的 thinking、tool call、tool result 分块显示，并可在前端分别隐藏。
- 修复消息时间使用接收时间的问题，历史消息显示更接近真实发生时间。
- 修复拖拽本地文件在浏览器中拿不到绝对路径的问题：现在会上传到服务端临时目录，再插入可读的服务端文件路径。
- 2.2.7 调整了聊天面板自动滚动：用户停在底部时继续自动跟随；用户向上查看历史时，新消息不会抢滚动位置，会显示“查看最新消息”按钮。

### 分享与手机端

- 新增 scoped session sharing。分享链接只能访问绑定会话，不能管理配置、写 agent、上传新增敏感接口或访问 full-access API。
- 分享链接生成时不再默认信任代理污染后的 Host，优先使用配置的 `web.publicBaseUrl`，否则使用可信 localhost/LAN 地址。
- 分享会话有效期可以在设置页的“其他”中配置，单位为小时；默认仍为 24 小时。
- 手机端和窄屏布局经过多轮修正：工作区选择、文件列表、工具栏、分享入口、Agent 选择和输入区更适合移动端。
- Android WebView 客户端支持打开 DPAgent 分享链接。

### Agent 与 Prompt

- 区分 bundled 内置 Agent、global 外部 Agent、workspace `AGENTS.md`。
- 内置 Agent 默认随包加载，但不在配置页编辑。
- 外部 Agent 默认可通过 `@agent` 使用；是否暴露给 subagent manager 由 `agent.yaml` 的 `exposeAsSubagent` 控制，默认不暴露。
- system prompt 分层：核心运行规则、Active Agent Role、Workspace Instructions、动态上下文分段分开注入。
- `@agent` 不再把完整 profile body 塞进 user prompt；workspace `AGENTS.md` 只作为仓库规则，不再覆盖 persona。

### 工具、技能与自动化

- `schedule_task` 成为基础工具，用于创建和取消定时任务。
- 新增 hook 系统，支持 onInputToLLM、onTurnEnd 等扩展点。
- 新增内置技能包：ASR 设置、hook build 示例。
- 新增 DPAI 分发技能方案与后端 API：`dpagent-update` 用于自升级，`dpagent-agent-create` 用于创建外部 Agent。
- 新增 Agent authoring API，可读取当前服务能力、生成外部 Agent、写入 `AGENTS.md` / `agent.yaml`，并支持 dry-run 和回滚。

### LLM 与上下文

- 支持多 LLM profile 和模型列表管理。
- 支持 OpenAI `xhigh` 与 Anthropic `max` 推理挡位。
- 优化长上下文、压缩、上下文预算、历史 replay 和工具调用上下文校验。
- 修复从大上下文模型切换到小上下文模型时缺少前端状态反馈的一系列路径。

## 升级注意事项

- 推荐使用 `npx dpagent` 启动当前包，不再使用旧 MiniMax Agent 入口。
- 外部 Agent 请放在配置的 `agent.globalAgentsDir/<name>/AGENTS.md` 下；内置 Agent 不应作为用户可编辑配置。
- 如果希望外部 Agent 能被 subagent manager 使用，需要在 `agent.yaml` 中显式加入：

```yaml
version: 1
exposeAsSubagent: true
```

- 分享链接是受限访问模式，不能调用系统配置、Agent authoring、自升级等 full-access API。
- 浏览器拖拽文件不会稳定暴露本机绝对路径；DPAgent 会改为上传文件并给 Agent 一个服务端可读路径。

## 2.2.10 摘要

- 新增包内预置 Agent：`dpagent-assistant`。用户可以通过 `@dpagent-assistant` 调用“DPAgent 助手”，用于教程、诊断、升级、外部 Agent 创建、分享客户端、ASR 配置和 Hook 构建。
- `dpagent-assistant` 随包携带 7 个 agent-bundled skills：`dpagent-user-guide`、`dpagent-debug-info`、`dpagent-update`、`dpagent-agent-create`、`dpagent-share-client`、`dpagent-asr-setup`、`dpagent-hook-build`。
- DPAgent assistant skills are packaged under `agents/dpagent-assistant/skill/`; release profile/key 类内部测试 skill 不进入公开用户层 skill 集。
- 清理旧的顶层 `skills/` 目录内容，移除与 DPAgent 运行时代码无关的本地 Codex skill 副本，避免 npm 包和源码树混入无关技能资产。
- npm 打包清单改为通过 `agents/**` 分发 DPAgent 助手及其 bundled skills，不再引用旧的 `skills/dpagent-asr-setup/**` 和 `skills/dpagent-hook-build/**` 路径。

## 2.2.9 摘要

- “其他”设置中新增分享会话有效期配置，按小时填写；新创建的分享链接会使用该配置计算过期时间，既有分享链接不被 retroactive 修改。
- 默认分享会话有效期保持 24 小时，配置范围限制在 1 到 720 小时，避免误填导致链接立即失效或长期不失效。
- 分享服务读取当前配置生成过期时间，设置保存后无需重启即可影响后续新分享。
- 后端设置 API、配置持久化、Web 设置页和分享服务补齐对应单测。

## 2.2.8 摘要

- `send_file_to_user` 下载链接改为在当轮 assistant 回复结束后统一显示为附件列表，不再作为普通 tool result JSON 插在对话中间。
- 下载附件列表不受 TB/TC/TR 前端过滤器影响；隐藏普通 tool result 时仍可看到可下载文件。
- `read_file` 默认读取从 200 行提升到 400 行，read_file 的内联结果与 artifact preview 提升到 20000 字符，减少中等长度文件的重复读取轮次。
- `read_tool_result` 默认读取对齐到 400 行 / 20000 字符，同时保留既有硬上限保护。

## 2.2.7 摘要

- 打包用户指南 Markdown、SVG 配图和 HTML guide 路由。
- 新增 `/guide` 到 `/guide/user-guide` 的只读入口，远端和分享访问均可打开。
- 聊天面板自动滚动改为“贴底才跟随”，避免用户查看历史时被新消息强制拉到底部。
- 继续保留 2.2.x 的 release gate：source gate、官方 npm publish preflight、pack audit 和安装 smoke。
