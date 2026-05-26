import { createAgent } from '../src/index.js';
import * as fs from 'fs';
import * as path from 'path';
import type { AgentCallback } from '../src/types.js';

const API_KEY = process.env.MINIMAX_INTEGRATION_API_KEY ?? 'YOUR_MINIMAX_API_KEY';

async function testCompression() {
  console.log('=== Context Compression Test ===\n');

  const callback: AgentCallback = {
    onThinking: (thinking) => {
      console.log('[Thinking] ' + thinking.substring(0, 100) + '...');
    },
    onToolCall: (name) => console.log(`[Tool] ${name}`),
    onToolResult: (name, result) => console.log(`[Result] ${name}: ${result.success ? 'OK' : 'FAIL'}`),
    onStep: (step, maxSteps) => console.log(`--- Step ${step}/${maxSteps} ---`),
    onComplete: () => console.log('[Complete]'),
  };

  const agent = createAgent({
    apiKey: API_KEY,
    workspaceDir: './workspace',
    storageConfig: {
      compressionThreshold: 500,  // 设置很小的阈值便于触发压缩
      targetCompressionRatio: 0.3,
      autoCompress: true,
    },
    config: {
      api: {
        apiKey: API_KEY,
        apiBase: 'https://api.minimaxi.com',
        model: 'MiniMax-M2.5',
        provider: 'anthropic',
      },
      agent: {
        maxSteps: 10,
        tokenLimit: 80000,
        workspaceDir: './workspace',
      },
      tools: {
        enableFileTools: true,
        enableShell: false,
        shellType: 'powershell',
        shellTimeout: 30000,
      },
      mcp: { enabled: false, servers: [], connectTimeout: 10, executeTimeout: 60 },
      retry: { enabled: true, maxRetries: 3, initialDelay: 1, maxDelay: 60, exponentialBase: 2 },
    },
  });

  const sessionId = 'compression-test-session';

  try {
    console.log('Initializing agent...\n');
    await agent.initialize(callback);

    // 删除旧的测试 session
    agent.deleteSession(sessionId);

    // 多轮对话累积内容
    const prompts = [
      '你好，我是张三，一名前端开发工程师。我正在开发一个React项目。',
      '我的项目名称是"智能助手仪表盘"，主要功能是展示各种AI助手的状态和统计数据。',
      '目前我已经完成了基础布局和导航组件，正在开发数据可视化部分。',
      '我遇到了一个问题：图表组件在移动端显示不正常，需要响应式设计。',
      '请帮我创建一个文件 notes.txt，记录我的项目信息和当前进度。',
    ];

    let totalSize = 0;
    const sessionDir = path.join('./workspace', 'dpagent-session', sessionId);

    for (let i = 0; i < prompts.length; i++) {
      console.log(`\n=== Turn ${i + 1} ===`);
      console.log(`Prompt: ${prompts[i].substring(0, 50)}...`);

      const result = await agent.runWithResult({
        prompt: prompts[i],
        sessionId,
        workspaceDir: './workspace',
      });

      // 检查当前状态
      const metaPath = path.join(sessionDir, 'session_meta.json');
      if (fs.existsSync(metaPath)) {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        console.log(`Total Size: ${meta.totalSize} bytes`);
        console.log(`Current Index: ${meta.currentIndex}`);
        console.log(`Compressed Count: ${meta.compressedCount}`);
        totalSize = meta.totalSize;
      }

      // 检查是否有压缩后的文件
      const compressedFile = path.join(sessionDir, 'history_message_1.jsonl');
      if (fs.existsSync(compressedFile)) {
        console.log('\n✅ Compression triggered! history_message_1.jsonl created.');
        const compressedContent = fs.readFileSync(compressedFile, 'utf-8');
        const compressedMessages = compressedContent.split('\n').filter(l => l.trim());
        console.log(`Compressed file has ${compressedMessages.length} message(s)`);
        
        // 显示压缩后的内容摘要
        if (compressedMessages.length > 0) {
          const firstMsg = JSON.parse(compressedMessages[0]);
          console.log(`Compressed content preview:\n${firstMsg.content.substring(0, 300)}...`);
        }
        break;
      }
    }

    // 最终检查
    console.log('\n\n=== Final State ===');
    const files = fs.readdirSync(sessionDir);
    console.log('Files in session directory:', files);

    const metaPath = path.join(sessionDir, 'session_meta.json');
    if (fs.existsSync(metaPath)) {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
      console.log('\nSession Meta:');
      console.log(`- Total Size: ${meta.totalSize}`);
      console.log(`- Current Index: ${meta.currentIndex}`);
      console.log(`- Compressed Count: ${meta.compressedCount}`);
    }

    console.log('\n=== Compression Test Complete ===');

  } catch (error) {
    console.error('Test failed:', error);
  } finally {
    await agent.cleanup();
  }
}

testCompression().catch(console.error);
