import { createAgent } from '../src/index.js';
import type { AgentCallback } from '../src/types.js';

const API_KEY = 'sk-cp-6VmqjCaCEtLrtmM1B2qAlObOAa_3XVf6fzqgwpk_oleR87SzhFT6ViXmPcGJyWI2nzGbQNFRkxsI-itPbLoSGU5dSwQJHI0CO1SdNqylAz2KZZbcHz82CSE';

async function testSkill() {
  console.log('=== Skill Integration Test ===\n');

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
      if (result.content) {
        console.log('Content:', result.content.substring(0, 300));
      }
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
    skillListPath: './skill-list.yaml',
    config: {
      api: {
        apiKey: API_KEY,
        apiBase: 'https://api.minimaxi.com',
        model: 'MiniMax-M2.5',
        provider: 'anthropic',
      },
      agent: {
        maxSteps: 20,
        tokenLimit: 80000,
        workspaceDir: './workspace',
        skillListPath: './skill-list.yaml',
      },
      tools: {
        enableFileTools: true,
        enableShell: true,
        shellType: 'powershell',
        shellTimeout: 60000,
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
    console.log('Initializing agent with skills...\n');
    await agent.initialize(callback);

    console.log('Config:', JSON.stringify(agent.getConfig().agent, null, 2));

    console.log('\n=== Running: Organize Desktop ===\n');
    
    const result = await agent.runWithResult({
      prompt: '请帮我整理桌面。先读取 skill 文件了解如何操作，然后执行整理。',
      workspaceDir: './workspace',
    });

    console.log('\n--- Final Result ---');
    console.log('Session ID:', result.sessionId);
    console.log('Content:', result.content);
    console.log('Usage:', result.usage);

  } catch (error) {
    console.error('Test failed:', error);
  } finally {
    await agent.cleanup();
  }
}

testSkill().catch(console.error);
