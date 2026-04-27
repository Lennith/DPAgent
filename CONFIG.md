# 配置说明

当前运行时的单一配置源是 `config.yaml`。

如果你是 npm 包用户，首次运行 `npx minimax-agent` 时会自动生成一个最小配置模板。  
如果你是仓库用户，可以直接编辑仓库根目录下的 `config.yaml`。

## 1. 最小可运行配置

```yaml
api:
  apiKey: "YOUR_API_KEY"
  apiBase: "https://api.minimaxi.com"
  model: "MiniMax-M2.7-highspeed"
  provider: "anthropic"
  maxOutputTokens: 32768

agent:
  workspaceDir: "./workspace"
  contextDir: "./contexts"
  runtimeDataDir: "./runtime"
  skillListPath: "./skill-list.yaml"
```

## 2. 当前常用配置项

```yaml
agent:
  maxSteps: 100
  tokenLimit: 210000
  workspaceDir: "./workspace"
  contextDir: "./contexts"
  runtimeDataDir: "./runtime"
  defaultToolset: "full-access"
  skillWriteMode: "auto"
  skillListPath: "./skill-list.yaml"
  skillsDir: "C:\\Users\\...\\.codex\\skills"
  globalAgentsDir: "./agents"
```

说明：

- `workspaceDir`
  默认工作目录，影响文件操作、Shell、workspace memory 和 skill 作用域
- `contextDir`
  上下文事件流目录
- `runtimeDataDir`
  runtime 下的 memory、skills、audit、session-search、todo 等数据根目录
- `defaultToolset`
  默认能力白名单；当前代码默认值是 `full-access`，如果希望默认更收敛，建议显式设置为 `windows-dev`
- `skillWriteMode`
  skill draft 是自动写入还是保留审批；当前代码默认值是 `auto`
- `skillListPath`
  显式配置的 skill 列表文件
- `skillsDir`
  外部 Codex skills 目录
- `globalAgentsDir`
  全局 agent 配置目录

## 3. API 配置

```yaml
api:
  apiKey: "YOUR_API_KEY"
  apiBase: "https://api.minimaxi.com"
  model: "MiniMax-M2.7-highspeed"
  provider: "anthropic"
  maxOutputTokens: 32768
```

注意：

- `apiKey` 必须有效
- `apiBase` 需要和 key 所在区域匹配
- `maxOutputTokens` 必须是正整数

## 4. tool 配置

```yaml
tools:
  enableFileTools: true
  enableWeb: true
  enableShell: true
  shellType: powershell
  shellTimeout: 30000
```

当前已经不再使用旧的 `enableNote` 配置。

## 5. MCP 配置

```yaml
mcp:
  enabled: true
  connectTimeout: 10
  executeTimeout: 60
  servers:
    - name: "MiniMax-Coding-Plan"
      type: "stdio"
      command: "uvx"
      args: ["minimax-coding-plan-mcp", "-y"]
      env:
        MINIMAX_API_KEY: "YOUR_API_KEY"
        MINIMAX_API_HOST: "https://api.minimaxi.com"
```

如果 `enabled: false` 或 `servers: []`，MCP 工具不会注册。

## 6. retry 配置

```yaml
retry:
  enabled: true
  maxRetries: 3
  initialDelay: 1
  maxDelay: 60
  exponentialBase: 2
```

## 7. 已移除的旧配置概念

当前版本已经移除或不再建议依赖：

- `session_note`
- `enableNote`
- `memoryWriteMode`
- 旧的 `minimax-agent.yaml`
- 旧的 `history_message_*.jsonl` 语义作为主上下文来源

## 8. 配置更新入口

运行后可以通过两种方式改配置：

- 直接编辑 `config.yaml`
- 在 Web UI 的 Settings / Config 中更新

当前 Web UI 可直接更新的主要项包括：

- API Base
- 模型
- `skillsDir`
- `globalAgentsDir`
- `defaultToolset`
- `skillWriteMode`

## 9. 校验建议

修改配置后，建议至少检查：

```bash
npx tsc --noEmit
npm run build:web
```

如果是发版前配置收敛，请按发布门禁走：

- [docs/INTERNAL_NPM_PUBLISH_STANDARD.md](docs/INTERNAL_NPM_PUBLISH_STANDARD.md)
