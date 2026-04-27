# MiniMax Agent（Node.js）

当前版本：`1.0.18`

MiniMax Agent 是一个本地优先的 TypeScript Agent 运行时，提供 Web 聊天界面、上下文持久化、长期 memory、skill 沉淀、子代理并行协作、MCP 工具接入，以及面向 Windows 的易用启动方式。

## 文档导航

- 用户试用说明：[docs/USER_GUIDE.md](docs/USER_GUIDE.md)
- 系统架构文档：[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- 当前设计文档：[docs/DESIGN.md](docs/DESIGN.md)
- 配置说明：[CONFIG.md](CONFIG.md)
- Windows 易用启动：[docs/WINDOWS_EASY_RUN.md](docs/WINDOWS_EASY_RUN.md)
- 子代理补充架构：[docs/SUBAGENT_ARCHITECTURE.md](docs/SUBAGENT_ARCHITECTURE.md)
- 发版门禁：[docs/INTERNAL_NPM_PUBLISH_STANDARD.md](docs/INTERNAL_NPM_PUBLISH_STANDARD.md)
- 私服发包流程：[docs/private-npm-publish.md](docs/private-npm-publish.md)
- 历史 phase gate 记录：[docs/phase-gates/README.md](docs/phase-gates/README.md)

## 当前能力

- 本地文件、Shell、上下文、memory、session search、todo、skill、sub-agent 等工具能力
- 基于 `contexts/` 的事件流上下文管理，支持长会话压缩和 compressed older-session context
- 基于 `runtime/memory/` 的长期记忆存储与后台 organize
- 基于 `runtime/skills/` 的 skill draft、审批、打包、激活、回滚
- 基于 toolset 的能力白名单和会话/工作区/团队三级覆盖
- Express + WebSocket + React 的 Web UI
- MCP 服务接入和运行状态展示

## 三个最常见的启动方式

### 1. 在仓库里开发运行

```bash
npm install
npm run dev:web
```

默认端口：

- 后端：`53721`
- 前端开发服务器：`53722`

### 2. 作为 npm 包使用

```bash
npm i @dpvr/minimax-agent --registry http://10.100.1.10:4873
npx minimax-agent
```

首次运行会在当前目录自动创建：

- `config.yaml`
- `skill-list.yaml`

然后启动 Web 服务，并默认尝试打开浏览器。

### 3. 使用 Windows 易用包

下载发布包后，直接运行：

```bash
Run-MiniMax.bat
```

详细说明见 [docs/WINDOWS_EASY_RUN.md](docs/WINDOWS_EASY_RUN.md)。

## 你需要先理解的三个概念

- `context`：当前会话的主上下文，包含结构化 context state、最近几轮会话连续性 replay，以及按需持久化的 compressed older-session context；原始来源是 `contexts/.../events.jsonl`
- `memory`：长期可复用事实，来源是 `runtime/memory/...`
- `skill`：可复用操作方法，来源是 `runtime/skills/...`

当前三条常用检索/管理通道也已经分开：

- `context_manage`：查看或修补当前 structured context 和 selected runtime context state
- `session_search`：搜索 prior session 的 raw transcript excerpt
- `memory_manage`：管理 durable memory

当前系统已经不再使用旧的 `session_note` 机制。  
长期 memory 也不再走审批流，而是通过后台 organize 自动晋升；skill 仍保留审批与治理能力。

## 常用命令

```bash
npm run build
npm run build:web
npm run start:web
npm test
npx tsc --noEmit
```

发版请不要只看这里，必须按 [docs/INTERNAL_NPM_PUBLISH_STANDARD.md](docs/INTERNAL_NPM_PUBLISH_STANDARD.md) 执行完整门禁。

## 目录概览

```text
src/         运行时代码
docs/        说明文档
contexts/    会话上下文事件流
runtime/     memory / skill / audit / session-search / todo 等运行数据
workspace/   默认工作目录
logs/        日志
tests/       单元和集成测试
```

## 当前文档约定

- 以 [docs/USER_GUIDE.md](docs/USER_GUIDE.md)、[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)、[docs/DESIGN.md](docs/DESIGN.md) 为当前版本主文档
- `docs/phase-gates/` 下内容属于阶段性验收记录，不作为当前功能契约的唯一来源
