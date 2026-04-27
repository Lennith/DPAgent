import { createAgent } from '../src/index.js';
import type { AgentCallback } from '../src/types.js';

const API_KEY = 'sk-cp-6VmqjCaCEtLrtmM1B2qAlObOAa_3XVf6fzqgwpk_oleR87SzhFT6ViXmPcGJyWI2nzGbQNFRkxsI-itPbLoSGU5dSwQJHI0CO1SdNqylAz2KZZbcHz82CSE';

async function testMigration() {
  console.log('=== MiniMax Agent Migration Test ===\n');

  const callback: AgentCallback = {
    onThinking: (thinking) => {
      console.log('\n[Thinking]');
      console.log(thinking.substring(0, 200) + '...');
    },
    onToolCall: (name, args) => {
      console.log(`\n[Tool Call] ${name}`);
      console.log('Args:', JSON.stringify(args, null, 2).substring(0, 200));
    },
    onToolResult: (name, result) => {
      console.log(`\n[Tool Result] ${name}: ${result.success ? 'Success' : 'Error'}`);
      if (!result.success) {
        console.log('Error:', result.error);
      }
    },
    onStep: (step, maxSteps) => {
      console.log(`\n--- Step ${step}/${maxSteps} ---`);
    },
    onMessage: (role, content) => {
      if (role === 'system') {
        console.log('\n[System Message]');
        console.log(content.substring(0, 150) + '...');
      }
    },
    onProtocolRecovery: (event) => {
      console.log('\n[Protocol Recovery]', event.kind);
      console.log('Error:', event.errorRaw.substring(0, 100));
    },
    onSummaryMessagesAccepted: (event) => {
      console.log('\n[Summary Messages Accepted]');
      console.log('Checkpoint:', event.checkpointId);
      console.log('Keep Recent:', event.keepRecentMessages);
    },
    onSummaryMessagesApplied: (event) => {
      console.log('\n[Summary Messages Applied]');
      console.log('Before Messages:', event.beforeMessages);
      console.log('After Messages:', event.afterMessages);
      console.log('Compacted:', event.compactedMessages);
    },
    onMaxTokensRecovery: (event) => {
      console.log('\n[Max Tokens Recovery]');
      console.log('Step:', event.step);
      console.log('Attempt:', event.attempt);
      console.log('Recovered:', event.recovered);
      console.log('Compression Mode:', event.compressionMode);
    },
    onComplete: (result, finishReason, meta) => {
      console.log('\n[Complete]');
      console.log('Finish Reason:', finishReason);
      console.log('Step:', meta?.step);
      console.log('Recovered from max_tokens:', meta?.recoveredFromMaxTokens);
    },
  };

  const agent = createAgent({
    apiKey: API_KEY,
    workspaceDir: './workspace',
    storageConfig: {
      compressionThreshold: 1000,
      autoCompress: true,
    },
    config: {
      api: {
        apiKey: API_KEY,
        apiBase: 'https://api.minimaxi.com',
        model: 'MiniMax-M2.5',
        provider: 'anthropic',
        maxOutputTokens: 16384,
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

    // Test 1: Basic conversation with checkpoint tracking
    console.log('=== Test 1: Basic Conversation with Checkpoint Tracking ===\n');
    const result1 = await agent.runWithResult({
      prompt: '你好！请列出当前工作目录下的所有文件。',
      workspaceDir: './workspace',
    });

    console.log('\n--- Result 1 ---');
    console.log('Session ID:', result1.sessionId);
    console.log('Finish Reason:', result1.finishReason);
    console.log('Step:', result1.step);
    console.log('Recovered from max_tokens:', result1.recoveredFromMaxTokens);

    // Test 2: Test summary_messages tool
    console.log('\n\n=== Test 2: Summary Messages Tool ===\n');
    const sessionId = result1.sessionId;
    
    const result2 = await agent.runWithResult({
      prompt: '请使用 summary_messages 工具列出所有可用的 checkpoint。',
      sessionId: sessionId,
      workspaceDir: './workspace',
    });

    console.log('\n--- Result 2 ---');
    console.log('Session ID:', result2.sessionId);
    console.log('Is New Session:', result2.isNewSession);

    // Test 3: Continue conversation to trigger more checkpoints
    console.log('\n\n=== Test 3: Multi-step Conversation ===\n');
    const result3 = await agent.runWithResult({
      prompt: '请读取 README.md 文件的内容（如果存在），然后总结一下。',
      sessionId: sessionId,
      workspaceDir: './workspace',
    });

    console.log('\n--- Result 3 ---');
    console.log('Step:', result3.step);
    console.log('Max Tokens Recovery Attempt:', result3.maxTokensRecoveryAttempt);

    // Test 4: List sessions and verify
    console.log('\n\n=== Test 4: List Sessions ===\n');
    const sessions = agent.listSessions();
    console.log('Total sessions:', sessions.length);
    for (const sid of sessions) {
      console.log(`- ${sid}`);
    }

    // Test 5: Get session info
    console.log('\n\n=== Test 5: Get Session Info ===\n');
    const sessionInfo = agent.getSession(sessionId);
    if (sessionInfo) {
      console.log('Session ID:', sessionInfo.id);
      console.log('Created At:', sessionInfo.createdAt);
      console.log('Updated At:', sessionInfo.updatedAt);
      console.log('Message Count:', sessionInfo.messages.length);
      
      // Check for checkpoint metadata
      const messagesWithMetadata = sessionInfo.messages.filter(m => m.metadata);
      console.log('Messages with Metadata:', messagesWithMetadata.length);
      
      for (const msg of messagesWithMetadata.slice(0, 3)) {
        console.log(`- ${msg.role}: checkpointId=${msg.metadata?.checkpointId}, reason=${msg.metadata?.checkpointReason}`);
      }
    }

    console.log('\n\n=== All Tests Complete ===');
    console.log('Migration verification complete! ✅');

  } catch (error) {
    console.error('Test failed:', error);
    process.exit(1);
  } finally {
    await agent.cleanup();
  }
}

testMigration().catch(console.error);
