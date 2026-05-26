# 下一版本开发计划：模型上下文窗口配置、压缩预算补强、远程访问密码

> 目标版本基线：以上一轮已合入的 `slim-refactor` + `context-compression-budget-fix` 为基础继续开发。
> 设计原则：按 `skill.md` 的 slim-refactor 思路，优先收敛预算口径和配置入口，不为修复单点问题继续增加分散分支；保留当前后端契约和运行语义，不为了通过测试改变 response / checkpoint / replay 协议。

---

## 0. 本版本要解决的问题

### 问题 1：模型缺少独立上下文窗口配置

当前上下文窗口预算仍然存在“全局值 / legacy 字符窗口 / provider 默认值”混杂的问题。下一版本需要支持：

- 前端可以按模型配置 context window。
- 后端按当前 provider + model 生效。
- 不再 hardcode 写死 230k / 240k 等值。
- 默认 context window 使用 **200k tokens**。
- 官方 context window 口径按 **tokens** 记录，char 只作为 fallback estimate。

### 问题 2：上下文窗口偏小，压缩触发和压缩窗口需要补强

上一轮已经避免把 240k token 误当作 230k chars，但仍然需要进一步补强：

- 主预算从 char-based 逐步切到 token-first。
- char 估算只作为没有 tokenizer / provider usage / provider count endpoint 时的 fallback。
- 单次压缩 chunk 永远按“当前可压缩上下文字符串总量的 1/3”切片。
- 对一个特别长 step 的单轮次，也要保证最多 3 个 compression chunk 可以覆盖当前可压缩上下文。
- 避免刚压缩完因为预算估算抖动马上再次压缩。

### 问题 3：远程访问前端时增加低强度密码门禁

需求边界：

- 本机访问前端不需要密码。
- 非本机访问前端时，需要先输入密码。
- 安全性不用很高，目标是方便远程访问时挡住随手打开页面的人。
- 密码功能需要覆盖静态前端页面和后端 API。
- 不能影响本地开发和本机访问。

---

## 1. 版本范围

### In scope

1. 新增模型级 context window 配置结构。
2. 修改配置读写和前后端设置页面。
3. 后端运行时按当前 model 解析 effective context budget。
4. 压缩触发逻辑改为 token-first / char-fallback。
5. 压缩 chunk 规则改为 `ceil(currentCompressibleChars / 3)`。
6. 增加压缩 hysteresis，避免压缩后短时间重复压缩。
7. 增加远程访问密码门禁。
8. 增加 focused tests / manual validation checklist。
9. 生成清晰的迁移说明。

### Out of scope

1. 不在本版本强制接入所有 provider 的真实 tokenizer。
2. 不要求完整实现 OpenAI / Anthropic count-tokens endpoint；如果已有 provider adapter 支持，可以接入统一接口，否则保留接口位。
3. 不改变 checkpoint / thinking replay / tool loop 的核心协议。
4. 不重写压缩模型 prompt 的语义，只调整预算、chunk 和触发策略。
5. 不做强安全认证系统，不引入用户管理、OAuth、权限角色。

---

## 2. 推荐数据结构改动

### 2.1 顶层配置

建议新增或收敛为以下结构。字段名可按现有代码风格调整，但语义应保持一致。

```ts
export interface ContextBudgetConfig {
  /**
   * 默认官方上下文窗口，单位 tokens。
   * 默认值：200_000。
   */
  defaultContextWindowTokens: number

  /**
   * fallback 估算参数。
   * 只在没有 provider usage / token counter / tokenizer 时使用。
   * 默认值：4，表示 1 token ≈ 4 chars。
   */
  estimatedCharsPerToken: number

  /**
   * 触发压缩的安全比例。
   * 默认建议 0.85。
   */
  compressionTriggerRatio: number

  /**
   * 压缩后目标比例。
   * 默认建议 0.35。
   */
  postCompressionTargetRatio: number

  /**
   * 压缩后再次触发压缩所需的最小增量。
   * 避免压缩后估算轻微抖动立刻再次压缩。
   */
  minTokensAddedAfterCompression: number

  /**
   * 为输出预留的 token。
   * 默认建议 8k-16k，可按现有 max output 设置联动。
   */
  reservedOutputTokens: number

  /**
   * 为 thinking / reasoning 预留的 token。
   * 如果当前模型没有 thinking mode，可以为 0。
   */
  reservedReasoningTokens: number

  /**
   * 为 tool schema / tool result wrapping / protocol overhead 预留。
   */
  reservedProtocolTokens: number

  /**
   * 模型级覆盖。
   * key 建议使用 `${provider}:${model}`，避免不同 provider 同名模型冲突。
   */
  modelOverrides: Record<string, ModelContextBudgetOverride>
}
```

```ts
export interface ModelContextBudgetOverride {
  contextWindowTokens?: number
  estimatedCharsPerToken?: number
  compressionTriggerRatio?: number
  postCompressionTargetRatio?: number
  reservedOutputTokens?: number
  reservedReasoningTokens?: number
  reservedProtocolTokens?: number
}
```

### 2.2 运行时解析结果

新增统一 resolver 的返回值，所有压缩触发、UI 百分比、provider trim budget 都使用这个结构。

```ts
export interface ResolvedContextBudget {
  provider: string
  model: string

  /**
   * 官方模型上下文窗口，单位 tokens。
   */
  contextWindowTokens: number

  /**
   * fallback 字符窗口。
   * 仅用于没有 token usage 时估算，不代表真实模型窗口。
   */
  estimatedContextWindowChars: number

  estimatedCharsPerToken: number

  compressionTriggerRatio: number
  postCompressionTargetRatio: number

  reservedOutputTokens: number
  reservedReasoningTokens: number
  reservedProtocolTokens: number

  safeInputTokens: number
  compressionTriggerTokens: number
  postCompressionTargetTokens: number

  /**
   * 预算来源，便于 debug 和 UI 展示。
   */
  source: "model_override" | "config_default" | "legacy_context_window_chars"
}
```

### 2.3 legacy 字段处理

保留读取旧字段，但不再让旧字段成为主预算。

```ts
contextWindowChars?: number
tokenLimit?: number
```

建议兼容规则：

1. 如果存在 `contextBudget.modelOverrides[provider:model].contextWindowTokens`，优先使用。
2. 否则使用 `contextBudget.defaultContextWindowTokens`。
3. 如果旧配置只有 `tokenLimit`，可迁移到 `defaultContextWindowTokens`。
4. 如果旧配置只有 `contextWindowChars`：
   - 不把它当作官方 context window。
   - 仅用于 fallback `estimatedContextWindowChars`。
   - 如果值等于 legacy 默认值 `230000`，直接忽略，避免旧 bug 回流。
5. 默认值统一为 `200_000 tokens`。

---

## 3. 后端处理逻辑改动

### 3.1 新增或修改预算 resolver

建议文件：

```text
src/runtime/context-window-budget.ts
```

目标：把预算计算彻底收敛到一个入口。

推荐导出：

```ts
export function resolveContextBudget(input: {
  config: AppConfig
  provider: string
  model: string
  modelRuntimeOptions?: {
    maxOutputTokens?: number
    thinkingBudgetTokens?: number
  }
}): ResolvedContextBudget
```

内部计算：

```ts
contextWindowTokens =
  modelOverride.contextWindowTokens
  ?? config.contextBudget.defaultContextWindowTokens
  ?? 200_000

estimatedCharsPerToken =
  modelOverride.estimatedCharsPerToken
  ?? config.contextBudget.estimatedCharsPerToken
  ?? 4

reservedOutputTokens =
  modelOverride.reservedOutputTokens
  ?? modelRuntimeOptions.maxOutputTokens
  ?? config.contextBudget.reservedOutputTokens
  ?? 16_000

reservedReasoningTokens =
  modelOverride.reservedReasoningTokens
  ?? modelRuntimeOptions.thinkingBudgetTokens
  ?? config.contextBudget.reservedReasoningTokens
  ?? 0

reservedProtocolTokens =
  modelOverride.reservedProtocolTokens
  ?? config.contextBudget.reservedProtocolTokens
  ?? 8_000

safeInputTokens =
  max(1, contextWindowTokens - reservedOutputTokens - reservedReasoningTokens - reservedProtocolTokens)

compressionTriggerTokens =
  floor(safeInputTokens * compressionTriggerRatio)

postCompressionTargetTokens =
  floor(contextWindowTokens * postCompressionTargetRatio)

estimatedContextWindowChars =
  floor(contextWindowTokens * estimatedCharsPerToken)
```

注意：

- `compressionTriggerTokens` 应基于 `safeInputTokens`，不是直接基于整个 context window。
- `postCompressionTargetTokens` 可以基于整个 context window，也可以基于 safe input budget；本版本建议基于 context window 并在报告中说明。
- 所有 magic number 必须集中在 resolver 默认值里，不允许散落到运行代码。

### 3.2 使用点替换

需要检查并替换以下位置：

```text
src/index.ts
src/runtime/context-replay-assembly.ts
src/runtime/context-window-budget.ts
src/runtime/turn-prompt.ts
src/web/server/WebServer.ts
src/context/ContextManager.ts
src/context/ContextProjector.ts
src/llm/*
```

实际替换原则：

- 不再直接读取 `config.contextWindowChars` 作为主预算。
- 不再在业务代码中写死 `230000`、`240000`、`tokenLimit * 4`。
- 业务代码只接收 `ResolvedContextBudget`。
- 如果 UI 需要显示 char estimate，也显示为 `estimatedContextWindowChars`，并标明是 estimate。

---

## 4. 压缩触发策略

### 4.1 token-first usage source

新增统一 usage estimate 结构：

```ts
export interface ContextUsageEstimate {
  inputTokens: number
  source:
    | "provider_usage"
    | "provider_count_endpoint"
    | "local_tokenizer"
    | "char_estimate"
  confidence: "exact" | "estimated"
  rawChars?: number
}
```

### 4.2 usage 估算优先级

优先级：

1. provider preflight count endpoint，如果 adapter 已支持。
2. provider response usage，用于更新 last known usage。
3. local tokenizer，如果已有或容易接入。
4. char fallback：`ceil(totalChars / estimatedCharsPerToken)`。

本版本最低要求：

- 必须实现第 4 层 fallback。
- 必须预留 provider count endpoint 接口位。
- 如果现有 adapter 已有 usage 字段，必须统一汇总到 `ContextUsageEstimate`，但不强制用它做 preflight。

### 4.3 压缩触发判断

推荐逻辑：

```ts
shouldCompress =
  estimate.inputTokens >= budget.compressionTriggerTokens
  && hasEnoughDeltaSinceLastCompression()
```

但如果接近硬上限，可以绕过 hysteresis：

```ts
hardRiskTokens = floor(budget.safeInputTokens * 0.95)

shouldCompress =
  estimate.inputTokens >= budget.compressionTriggerTokens
  && (
    tokensAddedSinceLastCompression >= budget.minTokensAddedAfterCompression
    || estimate.inputTokens >= hardRiskTokens
  )
```

### 4.4 provider overflow 兜底

如果 provider 返回 context overflow / validation error：

1. 判断错误类型。
2. 若本轮还没有 retry：
   - 强制压缩到 `postCompressionTargetTokens`。
   - 重组 replay-safe payload。
   - retry 一次。
3. 如果 retry 仍失败，抛出明确错误，不能无限重试。

---

## 5. 压缩 chunk 规则

### 5.1 目标

用户要求：

> 压缩窗口（单个 Chunk）永远以 1/3 当前上下文的字符串压缩，保证 3 轮压缩完。

本版本解释为：

- 每次进入 compression pass 时，先计算当前可压缩上下文的字符串总量。
- 单个 chunk 的最大字符串长度为 `ceil(compressibleChars / 3)`。
- 将当前可压缩内容按稳定边界切成最多 3 个 chunk。
- 每个 chunk 独立压缩或按顺序压缩。
- 对特别长的单轮 step，也最多 3 个 chunk 覆盖当前可压缩内容。

### 5.2 可压缩内容边界

不能压缩或不能破坏的内容：

- 当前未闭合的 assistant tool_use / tool_result bundle。
- Anthropic thinking mode 下必须原样 replay 的 thinking blocks。
- 当前 active turn 的必要 resume marker。
- side-effect ledger 需要保留的 checkpoint metadata。
- system prompt、tool schema、active user prompt。
- 未保存 replay-safe checkpoint 前的关键 transcript 节点。

可压缩内容：

- 老的 user / assistant text 历史。
- 已完成 tool result。
- 已经过 checkpoint 的 turn summary。
- 已经不需要原样 replay 的旧 transcript 片段。
- 特别长 step 中已经完成且不再需要逐字保留的 tool observation / file read result。

### 5.3 新增 chunk builder

建议文件：

```text
src/runtime/compression-chunks.ts
```

推荐接口：

```ts
export interface CompressionChunk {
  id: string
  startIndex: number
  endIndex: number
  charLength: number
  items: CompressibleTranscriptItem[]
}

export function buildCompressionChunks(input: {
  items: CompressibleTranscriptItem[]
  maxChunks?: number // default 3
}): CompressionChunk[]
```

内部规则：

```ts
const totalChars = sum(items.map(item => item.charLength))
const maxChunkChars = Math.ceil(totalChars / 3)

chunks = pack items in order, preserving item boundaries, until maxChunkChars
```

如果单个 item 超过 `maxChunkChars`：

- 对 text-like item 可以按文本边界切分。
- 对 structured / tool item 不能随便切时，允许单 chunk 超过 maxChunkChars，但要记录 warning。
- 不能为了凑 1/3 破坏 replay-safe 边界。

### 5.4 压缩后目标

每个 chunk 压缩 prompt 应明确要求：

```text
Summarize this chunk compactly while preserving:
- user intent
- decisions made
- files touched
- tool outputs needed later
- open tasks
- constraints
- unresolved errors
```

压缩结果应写回为统一 summary item，便于下一次估算和 replay。

---

## 6. 前端设置改动

### 6.1 设置页新增字段

建议新增“Model Context Budget”区块：

字段：

1. 默认上下文窗口 tokens
   - label: `Default context window tokens`
   - default: `200000`
2. 默认 chars/token 估算
   - label: `Estimated chars per token`
   - default: `4`
3. 压缩触发比例
   - label: `Compression trigger ratio`
   - default: `0.85`
4. 压缩后目标比例
   - label: `Post-compression target ratio`
   - default: `0.35`
5. 输出预留 tokens
   - label: `Reserved output tokens`
6. thinking 预留 tokens
   - label: `Reserved reasoning tokens`
7. protocol 预留 tokens
   - label: `Reserved protocol tokens`
8. 模型级 overrides 表格
   - provider
   - model
   - contextWindowTokens
   - estimatedCharsPerToken
   - reservedOutputTokens
   - reservedReasoningTokens
   - compressionTriggerRatio

### 6.2 API

建议接口：

```http
GET /api/config
PATCH /api/config/context-budget
```

或者复用现有 config update endpoint，但 payload 应结构化。

示例：

```json
{
  "defaultContextWindowTokens": 200000,
  "estimatedCharsPerToken": 4,
  "compressionTriggerRatio": 0.85,
  "postCompressionTargetRatio": 0.35,
  "reservedOutputTokens": 16000,
  "reservedReasoningTokens": 0,
  "reservedProtocolTokens": 8000,
  "modelOverrides": {
    "anthropic:claude-sonnet-4-5": {
      "contextWindowTokens": 200000,
      "reservedReasoningTokens": 32000
    },
    "deepseek:deepseek-v4": {
      "contextWindowTokens": 1000000,
      "estimatedCharsPerToken": 2
    }
  }
}
```

### 6.3 UI 显示 effective budget

建议在前端显示当前模型的 effective budget：

```text
Current model: anthropic:claude-sonnet-4-5
Context window: 200,000 tokens
Compression trigger: 147,900 input tokens
Reserved output: 16,000
Reserved reasoning: 32,000
Reserved protocol: 8,000
Budget source: model override
```

避免用户误以为 char estimate 是官方窗口。

---

## 7. 远程访问密码功能

### 7.1 行为定义

1. 如果请求来自本机：
   - 直接放行。
2. 如果请求来自非本机：
   - 未登录时跳转或返回 auth required。
   - 输入密码后设置 session cookie。
   - 后续请求带 cookie 放行。
3. 如果未配置密码：
   - 默认不启用门禁，避免用户升级后被锁在外面。
   - 前端设置页提示：`Remote access password is not configured`。

### 7.2 判断本机请求

新增 helper：

```ts
export function isLoopbackRequest(req: RequestLike): boolean
```

识别：

```text
127.0.0.1
::1
localhost
::ffff:127.0.0.1
```

如果在 reverse proxy 后面：

- 默认不要信任 `X-Forwarded-For`。
- 可新增配置 `trustProxy: boolean`。
- 只有 `trustProxy = true` 时才使用 forwarded headers。

### 7.3 配置结构

建议：

```ts
export interface RemoteAccessAuthConfig {
  enabled: boolean
  passwordHash?: string
  passwordSalt?: string
  sessionTtlMs: number
  trustProxy: boolean
}
```

默认：

```ts
{
  enabled: false,
  sessionTtlMs: 7 * 24 * 60 * 60 * 1000,
  trustProxy: false
}
```

即使安全性不用很高，也建议不要明文保存密码。可以使用 Node 内置 `crypto`：

```ts
crypto.scryptSync(password, salt, 32).toString("hex")
```

不引入新 dependency。

### 7.4 Auth API

建议新增：

```http
GET /api/auth/status
POST /api/auth/login
POST /api/auth/logout
```

`GET /api/auth/status` 返回：

```json
{
  "required": true,
  "authenticated": false,
  "local": false
}
```

`POST /api/auth/login`：

```json
{
  "password": "..."
}
```

成功后设置 cookie：

```text
HttpOnly
SameSite=Lax
Path=/
Max-Age=...
```

session cookie 内容可以是低强度 HMAC token：

```ts
payload = `${timestamp}:${randomNonce}`
signature = hmacSha256(serverSecret, payload)
cookie = base64url(`${payload}:${signature}`)
```

`serverSecret` 可在进程启动时生成或持久化到 config。低强度需求下，进程重启让 session 失效可以接受。

### 7.5 Middleware

建议在 `WebServer.ts` 加统一 middleware：

```ts
if (isLoopbackRequest(req)) return next()
if (isAuthExemptPath(req.path)) return next()
if (hasValidRemoteSessionCookie(req)) return next()

if (isApiPath(req.path)) {
  return json 401
}

return serve frontend auth shell / redirect to login
```

免鉴权路径：

```text
/api/auth/status
/api/auth/login
/static/*
favicon / assets
health check, if exists
```

注意：

- SSE / websocket / streaming API 也必须校验。
- 静态页面如果完全放行，会泄漏 UI；如果只是低强度门禁，可以允许 login shell 和 assets 放行，但 app API 必须拦截。
- logout 清 cookie。

---

## 8. 风险点

### 8.1 模型 context window 配置风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| 用户填错模型窗口 | 过早压缩或请求溢出 | UI 展示 effective budget，保留 overflow retry |
| provider/model key 不一致 | override 不生效 | 统一 key builder：`${provider}:${model}` |
| 旧 `contextWindowChars` 回流 | 再次低估窗口 | legacy 230000 必须忽略 |
| token 和 char 口径混淆 | UI 显示误导 | 前端明确区分 tokens / estimated chars |

### 8.2 压缩策略风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| 1/3 chunk 切破 replay-safe bundle | thinking/tool replay 出错 | chunk builder 必须尊重不可切边界 |
| 单个 tool result 超大 | 无法严格 1/3 | text-like 可切，structured 不可切时记录 warning |
| 压缩过度丢信息 | 后续任务质量下降 | chunk prompt 保留 decisions/files/open tasks/errors |
| 刚压缩完又压缩 | 用户体感糟糕 | hysteresis + hard risk override |
| 长单轮 step 无法等 turn 结束 | 中途爆 context | in-turn compression 必须可处理已完成 observation |

### 8.3 密码门禁风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| proxy 场景误判本机 | 远程绕过认证 | 默认不信任 X-Forwarded-For |
| cookie 没覆盖 SSE/API | 部分接口裸奔 | middleware 覆盖所有 routes |
| 未配置密码导致远程可访问 | 安全弱 | 默认行为要在 UI 明确提示 |
| 配置密码后本机也被拦 | 本地使用不便 | loopback bypass |
| 进程重启 session 失效 | 需要重新登录 | 可接受，或持久化 serverSecret |

---

## 9. Codex 开发步骤

### Step 1：基线确认

1. 确认已合入上一轮：
   - `slim-refactor.diff`
   - `context-compression-budget-fix.diff`
2. 跑当前 focused validation。
3. 记录当前预算相关文件和调用点。

输出：

```text
BASE_SHA
current budget entry points
current config API endpoints
current frontend settings components
```

### Step 2：实现 context budget config schema

1. 新增 `ContextBudgetConfig` / `ModelContextBudgetOverride` 类型。
2. 配置 loader 增加默认值：
   - `defaultContextWindowTokens = 200000`
   - `estimatedCharsPerToken = 4`
   - `compressionTriggerRatio = 0.85`
   - `postCompressionTargetRatio = 0.35`
3. 兼容旧字段：
   - `tokenLimit`
   - `contextWindowChars`
4. 增加 migration / normalization 函数。

验收：

- 新配置为空时，effective context window 为 `200000 tokens`。
- legacy `contextWindowChars = 230000` 不再作为主窗口。
- model override 可以覆盖默认值。

### Step 3：收敛 resolver

1. 修改 `runtime/context-window-budget.ts`。
2. 所有预算计算返回 `ResolvedContextBudget`。
3. 删除业务代码中的 magic context number。
4. `WebServer / api config / UI utilization / provider trim` 全部使用 resolver。

验收：

- 搜索不到散落的 `230000` 主预算逻辑。
- 搜索不到业务代码中直接 `tokenLimit * 4`。
- 当前模型切换后 effective budget 变化。

### Step 4：实现 usage estimate

1. 新增 `ContextUsageEstimate`。
2. 增加 char fallback estimator：
   - total chars / estimatedCharsPerToken
3. 如果 provider adapter 已返回 usage，归一化到 estimate。
4. 预留 `countInputTokens` adapter optional interface。

验收：

- 没有 provider counter 时仍能触发压缩判断。
- estimate source 会显示 `char_estimate`。
- provider usage 不重复计算 cache tokens。

### Step 5：修改压缩触发逻辑

1. 使用 `compressionTriggerTokens` 判断。
2. 加 hysteresis：
   - `lastCompressionInputTokens`
   - `tokensAddedSinceLastCompression`
3. 加 hard risk override。
4. 加 overflow retry 一次。

验收：

- 第一次压缩后，未新增足够 token 不会马上第二次压缩。
- 接近 hard risk 时仍会压缩。
- provider context overflow 只 retry 一次。

### Step 6：实现 1/3 compression chunk builder

1. 新增 `runtime/compression-chunks.ts`。
2. 收集可压缩 transcript items。
3. 计算：
   - `totalCompressibleChars`
   - `maxChunkChars = ceil(totalCompressibleChars / 3)`
4. 生成最多 3 个 chunk。
5. 保留 replay-safe 边界。
6. 对超大单 item 做 text split 或 warning。

验收：

- 90k chars 可压缩内容生成 3 个约 30k chunk。
- 单个 100k text item 可以切成最多 3 个 chunk。
- assistant tool_use + tool_result bundle 不被切坏。
- thinking block 不被压缩或丢弃。

### Step 7：前端配置页面

1. 新增 context budget 设置区块。
2. 新增 model override 表格。
3. 展示 current effective budget。
4. 保存到后端 config。
5. 做基础校验：
   - tokens 必须为正整数。
   - ratio 必须在 `(0, 1)`。
   - reserved tokens 不得大于 context window。

验收：

- 前端可新增 / 修改 / 删除模型 override。
- 保存后刷新仍保留。
- 当前模型 effective budget 与后端 resolver 一致。

### Step 8：远程访问密码

1. 新增 remote auth config。
2. 新增 hash / verify helper。
3. 新增 loopback 判断 helper。
4. 新增 auth API。
5. WebServer 增加 middleware。
6. 前端增加 login 页面或 auth gate。
7. 本机访问 bypass。

验收：

- `localhost` / `127.0.0.1` 访问不需要密码。
- 局域网 IP 访问需要密码。
- 登录后 API / SSE / static app 可继续访问。
- logout 后非本机 API 返回 401。
- 未配置密码时不锁死用户。

### Step 9：测试与验证

建议测试文件：

```text
tests/context-window-budget.test.ts
tests/compression-chunks.test.ts
tests/remote-access-auth.test.ts
```

重点用例：

1. default context window = 200k tokens。
2. model override 生效。
3. legacy 230000 chars 被忽略。
4. custom contextWindowChars 只作为 fallback estimate。
5. safe input budget 正确扣除 output / reasoning / protocol reserve。
6. char fallback token estimate 正确。
7. 1/3 chunk builder 最多生成 3 个 chunk。
8. replay-safe bundle 不被切开。
9. compression hysteresis 阻止连续压缩。
10. hard risk override 可以强制压缩。
11. loopback bypass。
12. remote auth required。
13. auth exempt paths 正常。
14. invalid password 不设置 session。
15. logout 清除 session。

### Step 10：回归场景手测

手测场景 A：240k 模型长 step

1. 设置当前模型 context window 为 240000。
2. 开始一个特别长的单轮 step。
3. 读入一个约 30k chars 文件。
4. 观察不应立即触发压缩。
5. 继续读入多份文件，接近 budget 时才触发。
6. 压缩后至少新增 `minTokensAddedAfterCompression` 前不应再次压缩。

手测场景 B：DeepSeek 1M 模型

1. 设置 `deepseek:deepseek-v4` context window 为 1000000。
2. 输入大文本。
3. UI 显示 context window 为 tokens。
4. char estimate 不被显示成官方窗口。

手测场景 C：远程访问

1. 本机打开，不需要密码。
2. 局域网另一台机器打开，需要密码。
3. 密码错误无法访问 API。
4. 密码正确后可以继续使用会话。
5. SSE / streaming 响应正常。

---

## 10. 验收标准

### 必须满足

1. 默认 context window 是 `200000 tokens`。
2. 前端可以配置模型级 context window。
3. 后端当前运行模型使用对应 override。
4. 旧 legacy `230000 chars` 不会把大 token 窗口压小。
5. 压缩触发用 token budget 优先，char 只是 fallback estimate。
6. 单次 compression pass 的 chunk 最大值来自 `ceil(currentCompressibleChars / 3)`。
7. 最多 3 个 chunk 覆盖当前可压缩内容。
8. 压缩不会切坏 thinking / tool replay-safe bundle。
9. 压缩后不会在未新增足够内容时立刻重复压缩。
10. 非本机访问前端需要密码。
11. 本机访问不需要密码。
12. 没配置密码时不锁死用户。
13. focused tests 通过。
14. 修改说明中列出残余风险。

### 不应出现

1. 业务代码中继续写死 `230000` 作为主窗口。
2. UI 把 char estimate 当成官方 context window。
3. 修改 checkpoint / replay / thinking 协议来绕过预算问题。
4. 远程 auth 只保护 HTML、不保护 API。
5. provider overflow 后无限 retry。
6. 压缩 chunk 为了凑 1/3 切断未闭合 tool bundle。

---

## 11. 建议提交结构

```text
commit 1: config schema + resolver defaults
commit 2: backend budget usage convergence
commit 3: compression usage estimate + hysteresis
commit 4: 1/3 compression chunk builder
commit 5: frontend context budget settings
commit 6: remote access password gate
commit 7: tests + migration docs
```

---

## 12. 给 Codex 的执行提示

开发时优先遵守以下顺序：

1. 先收敛预算数据结构，再改调用点。
2. 先保证默认 200k tokens 和 model override 生效。
3. 再改压缩触发。
4. 再改 chunk builder。
5. 最后加 remote password gate。
6. 每一步都做 focused validation。
7. 遇到测试和后端契约不一致时，按 contract-mismatch gate 分类，不要为了过测试改掉协议语义。

特别注意：

- 不要把 `estimatedCharsPerToken = 4` 当成真实模型窗口。
- 不要删除 legacy 读取，但 legacy 不能覆盖新 token window。
- 不要在多个模块重复计算 context budget。
- 不要压缩当前未完成的 Anthropic thinking/tool loop。
- 不要让远程 auth 影响 loopback。
