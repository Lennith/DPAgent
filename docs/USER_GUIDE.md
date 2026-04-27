# MiniMax Agent 用户试用说明

## 1. 这是什么

MiniMax Agent 是一个本地优先的 Agent 运行时。你可以把它理解成：

- 一个带 Web 界面的本地 AI 工作台
- 一个能在工作目录里读写文件、执行命令、调用工具的 Agent
- 一个会保存会话上下文、沉淀长期 memory、积累 skill 的系统

它主要适合下面三类场景：

- 在本地代码仓库里做开发、排障、重构、测试
- 在工作区里持续迭代一个长期任务，而不是一次性问答
- 需要让 Agent 记住稳定偏好、项目约定和常用流程

## 2. 三种启动方式

### 2.1 在源码仓库里运行

适合开发和调试。

```bash
npm install
npm run dev:web
```

默认端口：

- Web 后端：`53721`
- 前端开发服务器：`53722`

如果只想跑构建后的版本：

```bash
npm run build:web
npm run start:web
```

### 2.2 作为 npm 包使用

适合在新的项目目录里直接使用。

```bash
npm i @dpvr/minimax-agent --registry http://10.100.1.10:4873
npx minimax-agent
```

首次运行时，程序会在当前目录自动创建：

- `config.yaml`
- `skill-list.yaml`

然后启动 Web 服务，并默认尝试打开浏览器。

如果你只想生成配置，不想立刻启动：

```bash
npx minimax-agent init
```

### 2.3 使用 Windows 易用包

适合不想装 Node 依赖、只想直接跑。

直接执行：

```bash
Run-MiniMax.bat
```

详细说明见 [WINDOWS_EASY_RUN.md](./WINDOWS_EASY_RUN.md)。

## 3. 首次使用流程

### 第一步：准备 API Key

你可以在两种地方配置：

- 直接编辑 `config.yaml`
- 启动后在 Web UI 的 Settings 中填写

最少需要保证：

```yaml
api:
  apiKey: "YOUR_API_KEY"
  apiBase: "https://api.minimaxi.com"
  model: "MiniMax-M2.7-highspeed"
  provider: "anthropic"
  maxOutputTokens: 32768
```

### 第二步：确认工作目录

当前工作目录决定了 Agent 默认在哪个目录里读写文件、执行命令、建立上下文和沉淀 workspace memory。

常见做法：

- 在仓库根目录启动 `npx minimax-agent`
- 或者在 `config.yaml` 里设置 `agent.workspaceDir`

### 第三步：打开 Web UI

默认地址：

```text
http://localhost:53721
```

### 第四步：创建会话开始使用

进入界面后，建议按这个顺序开始：

1. 新建一个 session
2. 确认当前 session 绑定的工作目录
3. 根据任务选择合适的 toolset
4. 直接输入任务，让 Agent 开始执行

### 同目录多个 Session 共同生成

同一个 `workspaceDir` 下可以同时开多个 session。

- `session A` 可以负责实现
- `session B` 可以负责 review、测试或并行探索
- 两个 session 共享同一目录里的文件产物，但历史上下文、运行状态、取消操作彼此隔离

一个最小示例：

1. 创建 `session A`，工作目录设为 `D:\repo`
2. 创建 `session B`，工作目录也设为 `D:\repo`
3. 在 `session A` 里让 Agent 修改代码
4. 在 `session B` 里让 Agent 基于同一目录继续生成测试或做代码审查

约束：

- 同一 session 严格串行；上一轮没结束前，不会再接受该 session 的新运行
- 不同 session 可以并发，即使它们绑定到同一个工作目录

## 4. 界面怎么用

## 4.1 Sidebar

左侧主要负责会话和全局入口：

- session 列表
- 当前 session 切换
- 新建 / 删除 / 重命名 session
- 打开配置面板

## 4.2 Chat 区

中间是主聊天区域，负责：

- 显示用户消息、助手消息、工具调用、工具结果
- 展示流式输出
- 展示上下文压缩、max tokens recovery、plan input 等运行事件

## 4.3 Chat 输入区

输入区除了发消息，还有一个和 memory 相关的重要动作：

- `整理记忆`

它只会处理当前 session 里尚未整理的 committed turns，不会全局扫描所有 workspace。

## 4.4 Sub-Agent Panel

右侧子代理面板负责显示和管理：

- 子代理任务列表
- 运行中 / 失败 / 超时 / 已取消状态
- memory organize backlog
- 审计事件

## 4.5 Settings

设置面板里最常用的是：

- API Key
- API Base
- 模型
- 默认 toolset
- `skillsDir`
- `globalAgentsDir`
- `skillWriteMode`

## 5. 现在有哪些核心功能

## 5.1 文件和命令执行

Agent 可以在工作目录里：

- 读文件
- 写文件
- 编辑文件
- 搜索文件
- 执行 PowerShell 命令

默认更偏向 Windows 开发场景。

## 5.2 会话上下文

系统会自动保存：

- 每轮用户输入
- 助手输出
- 工具调用
- 工具结果
- 结构化上下文 patch

这些数据以事件流的方式保存在 `contexts/` 下。

如果你想直接查看或修补当前 session 的结构化状态，应该用：

- `context_manage`

它查看的是“当前有效 context view”，包括：

- committed structured context
- 当前 turn 尚未提交的 pending overlay
- 选定的 runtime context state，例如 `compressedHistoryContext`

## 5.3 长会话压缩

当会话变长时，系统不会简单丢掉历史，而是做两件事：

- 保留最近几轮会话连续性 replay
- 把更早历史压成一段 compressed older-session context，并持久化到 session 的 context state

这让上下文连续性和 token 成本之间保持平衡。

## 5.4 长期 memory

memory 用来保存跨轮仍然有价值的稳定事实，比如：

- 用户偏好
- 项目约定
- 常用命令
- 稳定工作流
- 长期有效 workaround

当前 memory 分为两层：

- `user`
- `workspace`

memory 不再走审批流。系统现在有三种整理触发方式：

- 每累计 3 个 committed turns 自动触发一次
- 当前 session 空闲 2 分钟后自动补刷
- 手动点击“整理记忆”

## 5.5 session search

如果你想回忆以前讨论过什么，系统会优先通过 session search 查：

- prior session 的 raw transcript excerpt

注意分工：

- `session_search` 只负责 raw transcript recall
- `context_manage` 负责当前 structured/runtime context state
- `memory_manage` 负责 durable memory

这三条通道是并列的，不会再互相冒充。

## 5.6 skill

skill 不是“事实记忆”，而是“可复用的方法”。

典型例子：

- 某个仓库的固定发布流程
- 某种排障步骤
- 某类修改的标准执行方法

当前 skill 机制支持：

- draft 生成
- 审批
- 列表 / 查看
- pack 发布
- pack 激活
- pack 回滚

和 memory 的区别：

- memory 保存稳定事实
- skill 保存可复用操作方法

## 5.7 子代理

你可以让主 Agent 调用子代理去做并行任务，例如：

- 一个子代理找代码
- 一个子代理跑测试
- 一个子代理做 review

子代理有独立生命周期，但共享同一个父会话上下文入口。

## 5.8 toolset

toolset 是能力白名单，不同 toolset 能看到的工具不同。

当前主要有：

- `windows-dev`
- `research`
- `windows-safe`

另外还有一个隐藏的内部默认集：

- `full-access`

toolset 可以在多个层级生效：

- 默认配置
- team preset
- workspace preset
- session override

## 5.9 MCP

如果你配置了 MCP，系统会把外部 MCP 工具接进来，并在 UI 中显示连接状态。

最常见用途：

- Web 搜索
- Web 抓取
- 图片理解
- 团队自定义工具

## 6. 推荐使用方式

### 方式一：直接给任务

适合一次性目标，例如：

- “检查这个仓库为什么构建失败”
- “给这个模块做 review”
- “把这个页面重构成组件化结构”

### 方式二：长期 session 持续迭代

适合需要多轮推进的工作，例如：

- 一个版本周期内持续维护同一仓库
- 让 Agent 逐步记住你的输出偏好和项目习惯

### 方式三：先给边界，再让它自己展开

例如：

- 指定工作目录
- 指定默认 toolset
- 说明哪些目录不能改
- 说明哪些脚本是标准验证路径

这样系统更容易沉淀出有效 memory 和 skill。

## 7. 常见目录

运行后常见目录如下：

```text
workspace/     默认工作目录
contexts/      会话事件流与上下文元数据
runtime/       memory、skills、audit、session-search、todos 等运行数据
logs/          日志
agents/        全局 agent 配置
skills/        工作区 skill 或补充 skill 目录
```

## 8. 常用配置项

最常用的是：

```yaml
agent:
  workspaceDir: "./workspace"
  contextDir: "./contexts"
  runtimeDataDir: "./runtime"
  defaultToolset: "full-access"
  skillWriteMode: "auto"
  skillListPath: "./skill-list.yaml"
  globalAgentsDir: "./agents"
```

说明：

- `defaultToolset`：运行时默认能力白名单；如果你希望默认更收敛，建议显式改成 `windows-dev`
- `skillWriteMode`：skill 是自动写入还是先走草稿审批；当前代码默认值是 `auto`
- `contextDir`：上下文事件流落盘目录
- `runtimeDataDir`：memory / skill / audit 等运行数据目录

## 9. 常见问题

### 9.1 能启动界面，但不能聊天

通常是 API Key 没配置好。先检查：

- `config.yaml`
- Settings 里的 API Key
- `apiBase` 是否和 Key 所在区域匹配

### 9.2 端口被占用

默认端口是 `53721`。如果被占用：

- 停掉占用进程
- 或用 `MINIMAX_PORT` 指定其他端口启动 Web 服务

### 9.3 memory 为什么没有立刻出现

memory 不是每轮同步写入。正常情况会在下面三种场景发生整理：

- 累计 3 个 committed turns
- 会话空闲 2 分钟
- 你手动点击“整理记忆”

### 9.4 为什么以前聊过的内容还能被找回，但不在 memory 列表里

因为那可能属于 `session_search` 命中的 raw transcript 历史，而不是长期 memory。

### 9.5 为什么 skill 还需要审批

当前设计里：

- memory 是长期事实，自动 organize
- skill 是可复用方法，仍然保留治理和审批

## 10. 下一步应该看什么

- 想理解系统怎么组织：看 [ARCHITECTURE.md](./ARCHITECTURE.md)
- 想理解为什么这样设计：看 [DESIGN.md](./DESIGN.md)
- 想改配置：看 [../CONFIG.md](../CONFIG.md)
