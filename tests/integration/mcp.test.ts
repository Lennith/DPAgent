import { createAgent } from '../src/index.js';
import { Tool } from '../src/tools/Tool.js';
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

async function testMCPConnection() {
  console.log('=== MCP Connection Test ===\n');

  const callback: AgentCallback = {
    onThinking: (thinking) => {
      console.log('\n[Thinking]');
      console.log(thinking.substring(0, 200) + '...');
    },
    onToolCall: (name, args) => {
      console.log(`\n[Tool Call] ${name}`);
      console.log('Args:', JSON.stringify(args, null, 2).substring(0, 300));
    },
    onToolResult: (name, result) => {
      console.log(`\n[Tool Result] ${name}: ${result.success ? 'Success' : 'Error'}`);
      if (result.content) {
        console.log('Content:', result.content.substring(0, 500));
      }
      if (result.error) {
        console.log('Error:', result.error);
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
      mcp: {
        enabled: true,
        servers: [MCP_SERVER_CONFIG],
        connectTimeout: 30,
        executeTimeout: 120,
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
    console.log('Initializing agent with MCP...\n');
    await agent.initialize(callback);

    const toolRegistry = agent.getToolRegistry();
    if (toolRegistry) {
      const tools = toolRegistry.getAll();
      console.log('\n=== Available Tools ===');
      for (const tool of tools) {
        console.log(`- ${tool.name}: ${tool.description.substring(0, 60)}...`);
      }
      
      const webSearchTool = tools.find((t: Tool) => t.name === 'web_search');
      const understandImageTool = tools.find((t: Tool) => t.name === 'understand_image');
      
      console.log('\n=== MCP Tools Status ===');
      console.log(`web_search: ${webSearchTool ? '✅ Available' : '❌ Not found'}`);
      console.log(`understand_image: ${understandImageTool ? '✅ Available' : '❌ Not found'}`);
    }

    console.log('\n\n=== Test 1: Web Search ===\n');
    const result1 = await agent.runWithResult({
      prompt: '请使用 web_search 工具搜索 "MiniMax M2.5 模型特点"，然后总结搜索结果。',
      workspaceDir: './workspace',
    });
    console.log('\n--- Web Search Result ---');
    console.log(result1.content.substring(0, 1000));

    console.log('\n\n=== Test 2: Image Understanding (Local File) ===\n');
    const result2 = await agent.runWithResult({
      prompt: '请使用 understand_image 工具分析本地图片：./assert/QQ图片20230226102255.png，详细描述图片内容。',
      workspaceDir: './workspace',
    });
    console.log('\n--- Image Understanding Result ---');
    console.log(result2.content.substring(0, 1000));

    console.log('\n\n=== All MCP Tests Complete ===');

  } catch (error) {
    console.error('Test failed:', error);
  } finally {
    await agent.cleanup();
  }
}

async function testWebSearchOnly() {
  console.log('=== Web Search Only Test ===\n');

  const callback: AgentCallback = {
    onToolCall: (name, args) => {
      console.log(`[Tool Call] ${name}`);
      console.log('Args:', JSON.stringify(args, null, 2));
    },
    onToolResult: (name, result) => {
      console.log(`[Tool Result] ${name}: ${result.success ? 'OK' : 'FAIL'}`);
      if (result.error) {
        console.log('Error:', result.error);
      }
      if (result.content) {
        console.log('Content:', result.content.substring(0, 500));
      }
    },
  };

  const agent = createAgent({
    apiKey: API_KEY,
    workspaceDir: './workspace',
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
        workspaceDir: './workspace',
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

  try {
    console.log('Initializing agent...\n');
    await agent.initialize(callback);

    const toolRegistry = agent.getToolRegistry();
    if (toolRegistry) {
      const tools = toolRegistry.getAll();
      const webSearchTool = tools.find((t: Tool) => t.name === 'web_search');
      console.log(`web_search tool: ${webSearchTool ? '✅' : '❌'}`);
    }

    console.log('\nRunning web search test...\n');
    const result = await agent.runWithResult({
      prompt: '使用 web_search 搜索今天的科技新闻，列出3条重要新闻标题。',
      workspaceDir: './workspace',
    });

    console.log('\n=== Result ===');
    console.log(result.content);

  } catch (error) {
    console.error('Test failed:', error);
  } finally {
    await agent.cleanup();
  }
}

const args = process.argv.slice(2);
if (args.includes('--web-only')) {
  testWebSearchOnly().catch(console.error);
} else {
  testMCPConnection().catch(console.error);
}
