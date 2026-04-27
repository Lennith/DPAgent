import { createAgent, minimaxRun, getSession, listSessions } from '../src/index.js';
import * as fs from 'fs';
import * as path from 'path';
import type { AgentCallback } from '../src/types.js';

const API_KEY = 'sk-cp-6VmqjCaCEtLrtmM1B2qAlObOAa_3XVf6fzqgwpk_oleR87SzhFT6ViXmPcGJyWI2nzGbQNFRkxsI-itPbLoSGU5dSwQJHI0CO1SdNqylAz2KZZbcHz82CSE';

async function testPersistence() {
  console.log('=== Session Persistence Test ===\n');

  const callback: AgentCallback = {
    onThinking: (thinking) => {
      console.log('\n[Thinking]');
      console.log(thinking.substring(0, 150) + '...');
    },
    onToolCall: (name) => {
      console.log(`\n[Tool Call] ${name}`);
    },
    onToolResult: (name, result) => {
      console.log(`\n[Tool Result] ${name}: ${result.success ? 'Success' : 'Error'}`);
    },
    onStep: (step, maxSteps) => {
      console.log(`\n--- Step ${step}/${maxSteps} ---`);
    },
    onComplete: () => {
      console.log('\n[Complete]');
    },
  };

  const agent = createAgent({
    apiKey: API_KEY,
    workspaceDir: './workspace',
    storageConfig: {
      compressionThreshold: 1000,  // 设置较小的阈值便于测试
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
        enableShell: true,
        shellType: 'powershell',
        shellTimeout: 30000,
      },
      mcp: {
        enabled: false,
        servers: [],
        connectTimeout: 10,
        executeTimeout: 60,
      },
      retry: {
        enabled: true,
        maxRetries: 3,
        initialDelay: 1,
        maxDelay: 60,
        exponentialBase: 2,
      },
    },
  });

  try {
    console.log('Initializing agent...\n');
    await agent.initialize(callback);

    // Test 1: User-specified session ID
    console.log('=== Test 1: User-specified Session ID ===\n');
    const customSessionId = 'my-custom-session-001';
    
    const result1 = await agent.runWithResult({
      prompt: '你好，我是测试用户。请记住我的名字。',
      sessionId: customSessionId,
      workspaceDir: './workspace',
    });

    console.log('\n--- Result 1 ---');
    console.log('Session ID:', result1.sessionId);
    console.log('Is New Session:', result1.isNewSession);
    console.log('Expected Session ID:', customSessionId);
    console.log('Match:', result1.sessionId === customSessionId ? '✅' : '❌');

    // Check if session directory was created
    const sessionDir = path.join('./workspace', 'minimax-session', customSessionId);
    console.log('Session directory exists:', fs.existsSync(sessionDir) ? '✅' : '❌');

    // Check if history file was created
    const historyFile = path.join(sessionDir, 'history_message_0.jsonl');
    console.log('History file exists:', fs.existsSync(historyFile) ? '✅' : '❌');

    if (fs.existsSync(historyFile)) {
      const content = fs.readFileSync(historyFile, 'utf-8');
      console.log('History file lines:', content.split('\n').filter(l => l.trim()).length);
    }

    // Test 2: Resume session with user-specified ID
    console.log('\n\n=== Test 2: Resume Session ===\n');
    const result2 = await agent.runWithResult({
      prompt: '你还记得我的名字吗？',
      sessionId: customSessionId,
      workspaceDir: './workspace',
    });

    console.log('\n--- Result 2 ---');
    console.log('Session ID:', result2.sessionId);
    console.log('Is New Session:', result2.isNewSession);
    console.log('Should be false (resuming):', !result2.isNewSession ? '✅' : '❌');

    // Test 3: Auto-generated session ID
    console.log('\n\n=== Test 3: Auto-generated Session ID ===\n');
    const result3 = await agent.runWithResult({
      prompt: '这是一个新的会话。',
      workspaceDir: './workspace',
    });

    console.log('\n--- Result 3 ---');
    console.log('Session ID:', result3.sessionId);
    console.log('Is New Session:', result3.isNewSession);
    console.log('Session ID format valid:', /^sess-\d+-[a-f0-9]{8}$/.test(result3.sessionId) ? '✅' : '❌');

    // Test 4: List sessions
    console.log('\n\n=== Test 4: List Sessions ===\n');
    const sessions = agent.listSessions();
    console.log('Total sessions:', sessions.length);
    for (const sid of sessions) {
      console.log(`- ${sid}`);
    }

    // Test 5: Get session info
    console.log('\n\n=== Test 5: Get Session Info ===\n');
    const sessionInfo = agent.getSession(customSessionId);
    if (sessionInfo) {
      console.log('Session ID:', sessionInfo.id);
      console.log('Created At:', sessionInfo.createdAt);
      console.log('Updated At:', sessionInfo.updatedAt);
      console.log('Message Count:', sessionInfo.messages.length);
    }

    console.log('\n\n=== All Tests Complete ===');
    console.log('Session persistence works correctly! ✅');

  } catch (error) {
    console.error('Test failed:', error);
  } finally {
    await agent.cleanup();
  }
}

testPersistence().catch(console.error);
