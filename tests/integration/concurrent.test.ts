import { createAgent } from '../src/index.js';
import type { AgentCallback, MCPServerConfig } from '../src/types.js';

const API_KEY = 'sk-cp-6VmqjCaCEtLrtmM1B2qAlObOAa_3XVf6fzqgwpk_oleR87SzhFT6ViXmPcGJyWI2nzGbQNFRkxsI-itPbLoSGU5dSwQJHI0CO1SdNqylAz2KZZbcHz82CSE';

const MCP_SERVER_CONFIG: MCPServerConfig = {
  name: 'MiniMax-Coding-Plan',
  type: 'stdio',
  command: 'uvx',
  args: ['minimax-coding-plan-mcp', '-y'],
  env: {
    MINIMAX_API_KEY: API_KEY,
    MINIMAX_API_HOST: 'https://api.minimaxi.com',
  },
  executeTimeout: 120000,
};

function createTestAgent(agentId: string, workspaceDir: string) {
  return createAgent({
    apiKey: API_KEY,
    workspaceDir,
    config: {
      api: {
        apiKey: API_KEY,
        apiBase: 'https://api.minimaxi.com',
        model: 'MiniMax-M2.5',
        provider: 'anthropic',
      },
      agent: {
        maxSteps: 5,
        tokenLimit: 40000,
        workspaceDir,
      },
      tools: {
        enableFileTools: false,
        enableShell: false,
        shellType: 'powershell',
        shellTimeout: 30000,
      },
      mcp: {
        enabled: true,
        servers: [MCP_SERVER_CONFIG],
        connectTimeout: 30,
        executeTimeout: 120,
      },
      retry: {
        enabled: true,
        maxRetries: 2,
        initialDelay: 1,
        maxDelay: 30,
        exponentialBase: 2,
      },
    },
  });
}

async function testIndependentSessions() {
  console.log('\n=== Test 1: Independent Sessions ===\n');
  
  const startTime = Date.now();
  
  const tasks = [
    { id: 'agent-1', prompt: '搜索 AI 人工智能最新进展', workspace: './workspace/concurrent/agent1' },
    { id: 'agent-2', prompt: '搜索 电动汽车市场动态', workspace: './workspace/concurrent/agent2' },
    { id: 'agent-3', prompt: '搜索 量子计算最新突破', workspace: './workspace/concurrent/agent3' },
  ];

  const results = await Promise.all(
    tasks.map(async (task) => {
      const agent = createTestAgent(task.id, task.workspace);
      
      const callback: AgentCallback = {
        onToolCall: (name) => console.log(`[${task.id}] Tool Call: ${name}`),
        onToolResult: (name, result) => 
          console.log(`[${task.id}] Tool Result: ${name} - ${result.success ? 'OK' : 'FAIL'}`),
      };

      try {
        await agent.initialize(callback);
        const result = await agent.runWithResult({
          prompt: `使用 web_search 工具${task.prompt}，总结3条关键信息。`,
          workspaceDir: task.workspace,
        });
        await agent.cleanup();
        return { id: task.id, success: true, content: result.content.substring(0, 300) };
      } catch (error) {
        return { id: task.id, success: false, error: String(error) };
      }
    })
  );

  const duration = Date.now() - startTime;
  
  console.log('\n--- Results ---');
  for (const r of results) {
    console.log(`[${r.id}] ${r.success ? '✅ Success' : '❌ Failed'}`);
    if (r.content) console.log(`  Content: ${r.content}...`);
    if (r.error) console.log(`  Error: ${r.error}`);
  }
  
  console.log(`\nDuration: ${duration}ms`);
  console.log(`All tasks completed: ${results.every(r => r.success) ? '✅' : '❌'}`);
  
  return results;
}

async function testSequentialVsParallel() {
  console.log('\n=== Test 2: Sequential vs Parallel ===\n');
  
  const prompts = [
    '搜索 Python 最新版本特性',
    '搜索 JavaScript 2025 趋势',
  ];

  // Sequential
  console.log('--- Sequential Execution ---');
  const seqStart = Date.now();
  for (let i = 0; i < prompts.length; i++) {
    const agent = createTestAgent(`seq-${i}`, `./workspace/concurrent/seq${i}`);
    await agent.initialize();
    await agent.runWithResult({ prompt: `使用 web_search ${prompts[i]}` });
    await agent.cleanup();
  }
  const seqDuration = Date.now() - seqStart;
  console.log(`Sequential duration: ${seqDuration}ms`);

  // Parallel
  console.log('\n--- Parallel Execution ---');
  const parStart = Date.now();
  await Promise.all(
    prompts.map(async (prompt, i) => {
      const agent = createTestAgent(`par-${i}`, `./workspace/concurrent/par${i}`);
      await agent.initialize();
      await agent.runWithResult({ prompt: `使用 web_search ${prompt}` });
      await agent.cleanup();
    })
  );
  const parDuration = Date.now() - parStart;
  console.log(`Parallel duration: ${parDuration}ms`);

  console.log(`\nSpeedup: ${(seqDuration / parDuration).toFixed(2)}x`);
}

async function testMCPConnectionLimit() {
  console.log('\n=== Test 3: MCP Connection Limit ===\n');
  
  const agentCount = 5;
  console.log(`Creating ${agentCount} agents with MCP connections...`);
  
  const agents = [];
  const initResults: { id: string; success: boolean; toolCount: number; error?: string }[] = [];

  const initStart = Date.now();
  
  for (let i = 0; i < agentCount; i++) {
    const agent = createTestAgent(`mcp-${i}`, `./workspace/concurrent/mcp${i}`);
    agents.push(agent);
  }

  const initPromises = agents.map(async (agent, i) => {
    try {
      await agent.initialize();
      const toolRegistry = agent.getToolRegistry();
      const tools = toolRegistry ? toolRegistry.getAll() : [];
      const webSearch = tools.find((t: { name: string }) => t.name === 'web_search');
      return { id: `mcp-${i}`, success: true, toolCount: tools.length, hasWebSearch: !!webSearch };
    } catch (error) {
      return { id: `mcp-${i}`, success: false, toolCount: 0, error: String(error) };
    }
  });

  const results = await Promise.all(initPromises);
  const initDuration = Date.now() - initStart;

  console.log('\n--- MCP Connection Results ---');
  for (const r of results) {
    console.log(`[${r.id}] ${r.success ? '✅' : '❌'} Tools: ${r.toolCount}, web_search: ${r.hasWebSearch ? '✅' : '❌'}`);
    if (r.error) console.log(`  Error: ${r.error}`);
  }

  console.log(`\nInit duration: ${initDuration}ms`);
  console.log(`Success rate: ${results.filter(r => r.success).length}/${agentCount}`);

  // Cleanup
  for (const agent of agents) {
    await agent.cleanup();
  }
}

async function main() {
  console.log('========================================');
  console.log('  Concurrent Agent Test Suite');
  console.log('========================================');

  const args = process.argv.slice(2);
  
  if (args.includes('--independent')) {
    await testIndependentSessions();
  } else if (args.includes('--compare')) {
    await testSequentialVsParallel();
  } else if (args.includes('--mcp-limit')) {
    await testMCPConnectionLimit();
  } else {
    // Run all tests
    await testIndependentSessions();
    console.log('\n');
    await testSequentialVsParallel();
    console.log('\n');
    await testMCPConnectionLimit();
  }

  console.log('\n========================================');
  console.log('  All Tests Complete');
  console.log('========================================\n');
}

main().catch(console.error);
