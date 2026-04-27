# MiniMax Agent 项目指南

> 本文档面向 AI 编程助手，介绍项目架构、开发规范和常用操作。

## 项目概述

MiniMax Agent 是一个基于 MiniMax API 的 AI Agent 工具包，可嵌入 Node.js 后端，具备以下核心能力：

- **本地操作**: 文件读写、Shell 命令执行、目录浏览
- **会话持久化**: 对话历史自动保存与恢复
- **上下文压缩**: 超长对话自动压缩以节省 Token
- **MCP 工具集成**: 支持 Model Context Protocol 标准的外部工具
- **Skill 扩展**: 通过 SKILL.md 文件添加领域特定能力
- **Web 界面**: 基于 React + Tailwind CSS 的现代化聊天界面

## 技术栈

### 后端
- **运行环境**: Node.js 18+
- **语言**: TypeScript 5.3+
- **模块系统**: ESM (ES Modules) + NodeNext 解析
- **主要依赖**:
  - `@anthropic-ai/sdk`: LLM API 客户端
  - `@modelcontextprotocol/sdk`: MCP 协议支持
  - `express`: Web 服务器
  - `ws`: WebSocket 通信
  - `zod`: 运行时类型校验
  - `js-yaml`: YAML 配置解析

### 前端
- **框架**: React 18
- **构建工具**: Vite 5
- **样式**: Tailwind CSS 3.4
- **语言**: TypeScript + TSX

## 项目结构

```
MinimaxAgentNodeJs/
├── src/                          # 源代码目录
│   ├── index.ts                  # 主入口，导出 MiniMaxAgent 类
│   ├── types.ts                  # 全项目类型定义
│   ├── agent/                    # Agent 核心逻辑
│   │   ├── Agent.ts              # 对话循环、工具调用编排
│   │   └── index.ts              # 模块导出
│   ├── llm/                      # LLM 客户端
│   │   ├── LLMClient.ts          # Anthropic SDK 封装
│   │   └── index.ts
│   ├── tools/                    # 内置工具集
│   │   ├── FileTools.ts          # 文件操作工具
│   │   ├── ShellTool.ts          # Shell 执行工具
│   │   ├── ToolRegistry.ts       # 工具注册表
│   │   └── Tool.ts               # 工具基类定义
│   ├── storage/                  # 会话存储
│   │   └── JSONLWriter.ts        # JSONL 格式写入
│   ├── compression/              # 上下文压缩
│   │   ├── ContextCompressor.ts  # LLM 驱动的压缩
│   │   └── prompts.ts            # 压缩提示词
│   ├── session/                  # 会话管理
│   ├── mcp/                      # MCP 连接器
│   │   └── MCPConnector.ts       # stdio/SSE 传输支持
│   ├── skills/                   # Skill 加载器
│   │   └── SkillLoader.ts        # SKILL.md 解析
│   ├── config/                   # 配置管理
│   │   ├── ConfigManager.ts      # 配置合并与验证
│   │   └── config.yaml           # 默认配置模板
│   ├── web/                      # Web 应用
│   │   ├── server/               # Express 后端
│   │   │   ├── WebServer.ts      # HTTP + WebSocket 服务
│   │   │   └── index.ts          # 服务入口
│   │   └── client/               # React 前端
│   │       ├── App.tsx           # 主应用组件
│   │       ├── main.tsx          # 前端入口
│   │       ├── index.html        # HTML 模板
│   │       ├── components/       # UI 组件
│   │       │   ├── chat/         # 聊天组件
│   │       │   ├── sidebar/      # 侧边栏组件
│   │       │   └── common/       # 通用组件
│   │       ├── hooks/            # React Hooks
│   │       └── styles/           # 样式定义
│   ├── test*.ts                  # 各类测试脚本
│   └── scripts/                  # 辅助脚本
├── dist/                         # 编译输出 (自动生成)
├── sessions/                     # 会话存储目录
├── workspace/                    # 默认工作目录
├── .env                          # 环境变量配置
├── skill-list.yaml               # Skill 列表配置
├── package.json                  # 项目依赖与脚本
├── tsconfig.json                 # TypeScript 配置
└── vite.config.ts                # Vite 构建配置
```

## 核心架构

### Agent 执行流程

```
用户输入 → Agent.run()
    ↓
加载历史消息 ← 上下文事件存储
    ↓
LLMClient.generateWithCallbacks() → 流式响应
    ↓
解析响应: 纯文本 / 思考内容 / 工具调用
    ↓
工具调用? → ToolRegistry.execute() → 执行结果
    ↓
保存新消息 → ContextEventStore.appendEvent()
    ↓
触发压缩? → ContextCompressor.compress()
    ↓
返回最终结果
```

### 会话持久化结构

```
workspace/.minimax/sessions/
└── <session-id>/
    └── events.jsonl                 # 原始对话历史与事件流
    ├── session_meta.json           # 会话元数据
    ├── shell-logs/                 # Shell 执行日志
    └── max_tokens_error_*.json     # Token 超限错误快照
```

### 消息格式 (JSONL)

```json
{"id":"msg-001","role":"user","content":"你好","timestamp":"2026-02-18T05:00:00.000Z"}
{"id":"msg-002","role":"assistant","content":"你好！","thinking":"用户在打招呼...","timestamp":"2026-02-18T05:00:05.000Z"}
```

## 开发命令

### 安装依赖
```bash
npm install
```

### 编译 TypeScript
```bash
# 开发模式（监听文件变化）
npm run dev

# 生产构建
npm run build
```

### 运行测试
```bash
# 运行基础会话持久化测试
npm test

# 运行编译后的测试
npm run test:run

# 运行 MCP 测试
npx tsx src/test-mcp.ts

# 运行并发测试
npx tsx src/test-concurrent.ts
```

### 启动 Web 界面
```bash
# 同时启动后端和前端（推荐）
npm run dev:web

# 仅后端（端口 53721）
npm run dev:server

# 仅前端（端口 53722）
npm run dev:client

# 构建 Web 应用
npm run build:web

# 启动生产环境服务
npm run start:web
```

### 代码检查
```bash
npm run lint
```

## 配置说明

### 环境变量 (.env)

```bash
# 必需: MiniMax API Key
MINIMAX_API_KEY=sk-cp-...

# 可选: API 基础地址
MINIMAX_API_BASE=https://api.minimaxi.com

# 可选: 模型选择
MINIMAX_MODEL=MiniMax-M2.7
```

**注意**: API Key 区域需与 API Base 匹配：
- 国内站: `https://api.minimaxi.com`
- 国际站: `https://api.minimax.io`

### YAML 配置 (config.yaml)

```yaml
api:
  apiKey: "YOUR_API_KEY"        # API Key（优先使用环境变量）
  apiBase: "https://api.minimaxi.com"
  model: "MiniMax-M2.7"
  provider: "anthropic"

agent:
  maxSteps: 100                 # 单轮最大步数
  tokenLimit: 80000             # Token 上限
  workspaceDir: "./workspace"   # 工作目录
  sessionDir: "./sessions"      # 会话存储目录
  skillListPath: "./skill-list.yaml"

mcp:
  enabled: true
  servers:
    - name: "MiniMax-Coding-Plan"
      type: "stdio"
      command: "uvx"
      args: ["minimax-coding-plan-mcp", "-y"]
      env:
        MINIMAX_API_KEY: "your-api-key"
        MINIMAX_API_HOST: "https://api.minimaxi.com"
```

### Skill 配置 (skill-list.yaml)

```yaml
skills:
  - name: "desktop-organizer"
    description: "桌面文件整理 Skill"
    path: "C:\\Users\\...\\.codex\\skills\\desktop-organizer\\SKILL.md"
    enabled: true
```

## 代码规范

### TypeScript 规范

1. **严格类型**: 启用 `strict: true`，避免使用 `any`
2. **ESM 模块**: 使用 `.js` 扩展名导入（编译后解析）
3. **类型导出**: 接口定义在 `types.ts`，业务类型使用 `type` 导入

```typescript
// 推荐
import type { AgentConfig } from './types.js';

// 不推荐
import { AgentConfig } from './types.js';  // 如果仅用于类型
```

### 命名规范

- **类名**: PascalCase (如 `MiniMaxAgent`, `ToolRegistry`)
- **接口/类型**: PascalCase (如 `AgentConfig`, `ToolResult`)
- **函数/方法**: camelCase (如 `runWithResult`, `createAgent`)
- **常量**: UPPER_SNAKE_CASE (如 `DEFAULT_CONFIG`)
- **私有成员**: 下划线前缀 (如 `_internalMethod`, 但实际使用 `#` 或 `private`)

### 错误处理

```typescript
try {
  const result = await someAsyncOperation();
} catch (error) {
  const err = error instanceof Error ? error : new Error(String(error));
  console.error('Operation failed:', err.message);
  throw err;
}
```

### 日志规范

使用带前缀的日志格式便于调试：

```typescript
console.log('[MiniMaxAgent] Initializing...');
console.log('[WebServer] Client connected');
console.log('[LLMClient] Streaming response...');
```

## 添加新工具

在 `src/tools/` 中创建工具类，继承 `Tool` 基类：

```typescript
import { Tool, createToolSchema, successResult, errorResult } from './Tool.js';

export class MyCustomTool extends Tool {
  constructor() {
    super(
      'my_tool',
      '工具描述',
      createToolSchema({
        type: 'object',
        properties: {
          param1: { type: 'string', description: '参数说明' },
        },
        required: ['param1'],
      })
    );
  }

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    try {
      // 实现逻辑
      return successResult('操作成功');
    } catch (error) {
      return errorResult(`操作失败: ${error}`);
    }
  }
}
```

在 `src/index.ts` 中注册：

```typescript
import { MyCustomTool } from './tools/MyCustomTool.js';

// 在 initialize() 中
this.toolRegistry.register(new MyCustomTool());
```

## 测试策略

### 测试脚本位置

- `src/test.ts`: 基础会话持久化测试
- `src/test-mcp.ts`: MCP 连接测试
- `src/test-compression.ts`: 上下文压缩测试
- `src/test-concurrent.ts`: 并发执行测试
- `src/test-skill.ts`: Skill 加载测试

### 运行测试

```bash
# 使用 tsx 直接运行（推荐，支持 TypeScript）
npx tsx src/test.ts

# 或先编译再运行
npm run build
node dist/test.js
```

### 测试注意事项

1. 测试需要有效的 `MINIMAX_API_KEY`
2. 测试会创建实际文件在 `./workspace` 目录
3. 并发测试会同时启动多个 Agent 实例

## 常见问题

### MCP 服务器无法连接

确保已安装 `uv`（Python 包管理器）：

```powershell
# Windows
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"

# 验证
uvx --version
```

### WebSocket 连接失败

检查端口占用情况：
- 后端默认端口: 53721
- 前端开发服务器: 53722
- HMR 端口: 53723

### 会话数据未保存

检查 `workspaceDir` 和 `sessionDir` 配置，确保：
1. 目录存在且有写权限
2. 磁盘空间充足
3. 未被 `.gitignore` 排除

## 安全注意事项

1. **API Key 管理**: 永远不要提交 `.env` 文件到 Git
2. **Shell 命令**: 默认启用 PowerShell，支持命令超时和输出限制
3. **文件访问**: 通过 `PermissionManager` 限制可访问目录
4. **MCP 服务器**: 仅连接可信的 MCP 服务器

## 相关资源

- [MiniMax 开放平台](https://platform.minimaxi.com)
- [MCP 协议文档](https://modelcontextprotocol.io)
- [Anthropic TypeScript SDK](https://github.com/anthropics/anthropic-sdk-typescript)

**git 规则**
1. commit必须 -s，不允许使用中文commit
2. 只允许git push origin HEAD:refs/for/master，**严禁绕靠gerrit直接push**
## 回归与发版门禁

### 文档入口

- UX 探索迭代标准：`docs/UX_ITERATION_STANDARD.md`
- 发版门禁标准：`docs/INTERNAL_NPM_PUBLISH_STANDARD.md`
- 私服发包操作指南：`docs/private-npm-publish.md`

### 边界约束

1. `ux:iterate*`、`ux:long-context*`、`ux:ui-focused*` 属于探索型 UX 迭代，不是发版门禁。
2. 探索型 UX 流程允许产生 `ux-workspace/` 证据与修复建议，但不允许作为发版放行依据。
3. 发版门禁只允许使用维护中的固定回归项；当前唯一纳入门禁的 UX 功能验收用例是 `npm run smoke:ui`。
4. 发版必须按 `docs/INTERNAL_NPM_PUBLISH_STANDARD.md` 执行；`publish:standard` 是唯一标准发版命令，`publish:standard:preflight` 仅作可选本地演练。
5. `ux-workspace/` 产物默认保留用于分析，清理由人工显式执行。
