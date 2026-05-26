# 技术债务清缴计划（第二轮）

## 背景

上轮已完成：
- `ContextBudgetConfig` 数据结构 + 200k tokens 默认值 + legacy 230000 chars 迁移忽略
- `context-window-budget.ts` 统一预算解析器
- `Agent.ts` / `SubAgentTurnRunner.ts` / `ContextReplayAssembler.ts` / `WebServer.ts` 后端调用点收敛（消除 `230000` 魔数）
- Token-first 压缩触发 + hysteresis + hard risk override
- `compression-chunks.ts` 1/3 chunk 构建器（独立模块）
- `remote-access-auth.ts` 后端认证基础设施 + middleware + API 路由

本轮目标：清缴以下 5 项技术债务。

---

## Task 1：整合 compression-chunks.ts 到 Agent.ts 压缩管线

**现状**：Agent.ts 中保留旧的 5 个内联方法（`splitMessagesForPrecompress`, `chunkMessagesForCompression`, `resolveAdaptiveCompressionChunks`, `buildCompressionChunk`, `mergeSmallCompressionChunks`），共 ~180 行。它们与 `compression-chunks.ts` 中的 `buildCompressionChunks` 独立存在但未被调用。

**目标**：将 Agent.ts 的 `applyPrecompressIfNeeded`（约第 948-1100 行）中调用 `resolveAdaptiveCompressionChunks` 的位置替换为调用 `compression-chunks.ts` 中的 `collectCompressibleItems` + `buildCompressionChunks`，并适配后续压缩循环。

### 具体步骤

1. **扩展 `CompressibleTranscriptItem`**（`compression-chunks.ts`）
   - 新增 `preparedMessages?: PersistedMessage[]` 字段，供旧 compression loop 消费

2. **修改 `buildCompressionChunks` 的行为**
   - 调用方需要知道每个 chunk 对应的原始 `olderMessages` 切片（旧代码中 `chunk.messages` 被传给 `buildCompressionChunk`，再传给 `compressChunksWithRetry`）
   - 需从 `items[].messageIndex` 反向映射出 `Message[]` 切片
   - 新增辅助函数 `extractChunkMessages(messages, chunk)` 根据 index 范围切出原始消息

3. **删除 Agent.ts 中的 5 个旧方法**
   - `splitMessagesForPrecompress`（609-657）→ 保留，不做修改（轮次分割逻辑不需改动）
   - `chunkMessagesForCompression`（659-683）
   - `resolveAdaptiveCompressionChunks`（685-713）
   - `buildCompressionChunk`（715-736）
   - `mergeSmallCompressionChunks`（738-763）
   - 内部 `CompressionChunk` interface（67-74）

4. **替换 `applyPrecompressIfNeeded` 中的调用点**
   - 旧代码路径：`split.olderMessages` → `resolveAdaptiveCompressionChunks` → `chunks: CompressionChunk[]`（含 `messages` + `preparedMessages`）
   - 新代码路径：`split.olderMessages` → `collectCompressibleItems` → `buildCompressionChunks` → 按 index 反查 `Message[]` → `buildCompressionChunkPrompt`
   - **关键**：`compressChunksWithRetry` 消费的是旧格式的 `CompressionChunk`（含 `preparedMessages: PersistedMessage[]`），需要确保新 chunks 也能提供 `preparedMessages`

5. **验证**：现有 `context-history-replay.test.ts` 中 `runDigestSystemPromptCase` 需通过

### 替换策略（最小风险）

不在本轮强行合并两条分块路径（1/3 均匀分块 vs 自适应分块），而是：
- 保留 `resolveAdaptiveCompressionChunks` 的自适应逻辑作为 wrapper
- 将其内部调用从 `chunkMessagesForCompression` 替换为 `buildCompressionChunks` + `extractChunkMessages`
- 移除 `buildCompressionChunk` 和 `mergeSmallCompressionChunks`

---

## Task 2：远程访问密码配置入口（后端 API + 前端设置）

### 2.1 POST /api/config 支持 remoteAccessAuth

**文件**：`src/web/server/web-server-route-registration.ts`

**改动**：
1. 在 `POST /api/config` 的解析参数中新增 `remoteAccessAuth`：
   ```typescript
   remoteAccessAuth?: {
     enabled?: boolean;
     password?: string;        // 明文密码，仅在非空时更新
     clearPassword?: boolean;  // 设为 true 清除密码
     sessionTtlMs?: number;
     trustProxy?: boolean;
   };
   ```

2. 密码处理逻辑：
   - 若 `password` 非空 → 调用 `hashPassword(password)` 生成 `{ passwordHash, passwordSalt }`
   - 若 `clearPassword === true` → 将 `passwordHash`/`passwordSalt` 设为 `undefined`
   - 若均无 → 保持现有密码不变

3. 密码字段**不在** `GET /api/config` 或 `GET /api/settings` 中返回

### 2.2 GET /api/settings 返回 remoteAccessAuth 状态

**文件**：`src/web/server/web-server-route-registration.ts`

新增返回字段：
```json
{
  "remoteAccessAuth": {
    "enabled": false,
    "configured": false,
    "sessionTtlMs": 604800000,
    "trustProxy": false
  }
}
```
- `configured` = `!!passwordHash`（密码是否已设置）
- 不返回 `passwordHash`/`passwordSalt`

### 2.3 ConfigModal 新增 remoteAccessAuth 设置

**文件**：`src/web/client/components/ConfigModal.tsx`

在 "Other" 标签页中新增 remote access 区块：
- **启用开关**：checkbox，"Enable remote access password"
- **密码输入**：password 输入框（仅 enabled 时显示），placeholder "Enter password (leave blank to keep current)"
- **清除密码按钮**：button，"Clear password"（仅 configured 时显示）
- **Session TTL**：下拉框或数字输入，选项：1h / 12h / 1d / 7d / 30d
- **Trust Proxy**：checkbox（高级，默认折叠）

脏检测逻辑：与现有 `skillsDir`/`globalAgentsDir` 相同的模式（initial 值 vs 当前值）

### 2.4 登录页面

**文件**：`src/web/client/components/LoginPage.tsx`（新建）

- 极简页面：居中卡牌，标题 "DPAgent" + 'Remote Access' 副标题
- 密码输入框 + "Login" 按钮
- 调用 `POST /api/auth/login`
- 成功后重定向到 `/`
- 错误提示："Invalid password"
- 与主题系统一致（支持 dark/light）

### 2.5 App.tsx 认证守卫

**文件**：`src/web/client/App.tsx`

- 在应用初始化时调用 `GET /api/auth/status`
- 若 `required === true && authenticated === false` → 渲染 `<LoginPage />`
- 若 `required === false || authenticated === true` → 正常渲染主界面
- 不需要创建新的路由（使用条件渲染而非 react-router）

---

## Task 3：Compression chunk 集成到 Agent 压缩 pass（替换策略）

使用上文的「替换策略」：
1. 新增 `extractChunkMessages(messages: Message[], chunk: CompressionChunk): Message[]` 到 `compression-chunks.ts`
2. 修改 Agent.ts 的 `resolveAdaptiveCompressionChunks` → 调用 `collectCompressibleItems` + `buildCompressionChunks` + `extractChunkMessages`
3. 删除 `chunkMessagesForCompression`、`buildCompressionChunk`、`mergeSmallCompressionChunks` 三个方法
4. 保留 `CompressionChunk` interface 但调整其内容（或删除旧 interface 统一用新模块的类型）

---

## Task 4：测试修复

### 修复 `context-history-replay.test.ts` 中 `runDigestSystemPromptCase`

**根因**：旧计算使用 `estimatePreparedMessageCharacters`（已规范化消息），新计算使用 `estimateMessageCharacters`（原始消息）。这导致字符估算值不同，从而影响压缩触发判断。

**修复策略**：
- 在 `compression-chunks.ts` 的 `collectCompressibleItems` 中改用与 `ContextPayloadProjector.projectForProvider` 一致的估算方式，或
- 在 Agent.ts 的集成点使用 `projectForProvider` 的结果来计算 `compressibleItems.charLength`，或
- 调整测试中的 `contextPrecompressTriggerRatio` 以使总字符数自然跨过触发阈值

**推荐策略**：调整测试的 `contextPrecompressTriggerRatio`（从 `0.1` 调至更合理的值，如 `0.05`）或增加 `makeLongText` 长度。这样可以避免对分块逻辑本身产生测试影响。

---

## Task 5：前端 Context Budget 设置页面

### 5.1 ConfigModal 新增 Context Budget 区块

**文件**：`src/web/client/components/ConfigModal.tsx`

在 "Other" 标签页中 `maxSteps` / `completionMarkerEnforcementEnabled` 之后新增：

**上下文窗口 & 压缩**：
| 字段 | 标签 | 类型 | 默认值 |
|---|---|---|---|
| contextReplayMinRounds | Min replay rounds | number ≥1 | 6 |
| contextReplayMaxRounds | Max replay rounds | number ≥1 | 12 |
| contextReplayBudgetRatio | Replay budget ratio | number (0-1) | 0.55 |
| contextWindowChars | Context window chars (fallback) | number | 230000 |
| contextPrecompressTriggerRatio | Precompress trigger ratio | number (0-1) | 0.85 |
| contextPrecompressKeepLlmRounds | Keep LLM rounds after precompress | number ≥1 | 5 |
| contextPrecompressChunkChars | Precompress chunk chars | number ≥4000 | 60000 |
| contextCompressionMaxChars | Compression max chars | number ≥400 | 6000 |

使用与 `maxSteps` 相同的数字输入组件模式。

### 5.2 POST /api/config 支持这些字段

**文件**：`src/web/server/web-server-route-registration.ts`

新增对下列字段的接收和持久化：
```typescript
contextReplayMinRounds, contextReplayMaxRounds, contextReplayBudgetRatio,
contextWindowChars, contextPrecompressTriggerRatio,
contextPrecompressKeepLlmRounds, contextPrecompressChunkChars,
contextCompressionMaxChars
```

### 5.3 GET /api/settings 返回这些字段

**文件**：同上

在返回的 `agent` 对象中新增上述 8 个字段。

---

## 执行顺序

| 顺序 | 任务 | 预计工作量 | 依赖 |
|------|------|-----------|------|
| 1 | Task 3: Compression chunk 集成到 Agent | ~60 行改 | 无 |
| 2 | Task 4: 测试修复 | ~15 行改 | Task 3 |
| 3 | Task 2.1: POST /api/config 支持 remoteAccessAuth | ~50 行新增 | 无 |
| 4 | Task 2.2: GET /api/settings 返回 auth 状态 | ~15 行新增 | Task 2.1 |
| 5 | Task 2.3: ConfigModal auth 设置 | ~50 行新增 | Task 2.2 |
| 6 | Task 2.4: 登录页面 | ~80 行新建 | 无 |
| 7 | Task 2.5: App.tsx 认证守卫 | ~25 行新增 | Task 2.4 |
| 8 | Task 5.1: ConfigModal Context Budget 区块 | ~100 行新增 | 无 |
| 9 | Task 5.2: POST /api/config 支持 context budget | ~30 行新增 | 无 |
| 10 | Task 5.3: GET /api/settings 返回 context budget | ~15 行新增 | 无 |
| 11 | 构建验证 | - | 全部 |
| 12 | Commit | - | 全部 |

---

## 不在本轮范围

- 模型级 contextBudget override UI（modelOverrides 表格）— 下次迭代
- Token 计数端点接入（provider count endpoint）— 下次迭代
- 真实 tokenizer 接入 — 下次迭代
- 完整 e2e 测试 — 下次迭代
