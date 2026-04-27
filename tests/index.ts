/**
 * MiniMax Agent Test Suite
 * 
 * 测试分类：
 * - integration/: 集成测试（需要 API Key，测试完整流程）
 * - unit/: 单元测试（测试单个模块）
 * - e2e/: 端到端测试（预留）
 * 
 * 运行测试：
 *   npm run test:persistence    # 会话持久化测试
 *   npm run test:compression    # 上下文压缩测试
 *   npm run test:mcp           # MCP 连接测试
 *   npm run test:concurrent    # 并发测试
 *   npm run test:migration     # 迁移测试
 *   npm run test:skill         # Skill 加载测试
 */

// 测试环境检查
const API_KEY = process.env.MINIMAX_API_KEY;

if (!API_KEY) {
  console.warn('⚠️  Warning: MINIMAX_API_KEY not set in environment');
  console.warn('   Some tests may fail without a valid API key');
}

export {};
