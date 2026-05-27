import * as assert from 'node:assert/strict';
import { ConfigManager } from '../../src/config/ConfigManager.js';
import { DEFAULT_TOOLSETS, Tool, ToolsetRegistry, createToolsetRegistry } from '../../src/tools/index.js';
import type { ToolResult } from '../../src/types.js';

class FakeTool extends Tool {
  constructor(
    private readonly toolName: string,
    private readonly toolDescription: string,
    private readonly toolParameters: Record<string, unknown> = { type: 'object', properties: {} }
  ) {
    super();
  }

  get name(): string {
    return this.toolName;
  }

  get description(): string {
    return this.toolDescription;
  }

  get parameters(): Record<string, unknown> {
    return this.toolParameters;
  }

  async execute(): Promise<ToolResult> {
    return { success: true, content: 'ok' };
  }
}

function runAll(): void {
  const registry = new ToolsetRegistry();
  const shellTool = new FakeTool('shell_execute', 'shell');
  const webSearchTool = new FakeTool('web_search', 'search');
  const readToolResultTool = new FakeTool('read_tool_result', 'read stored tool result');
  const sendFileTool = new FakeTool('send_file_to_user', 'send file to user');
  const requestUserInputTool = new FakeTool('request_user_input', 'request user input');
  const todoTool = new FakeTool('todo', 'todo');
  const unknownTool = new FakeTool('custom_unknown_tool', 'custom');

  assert.equal(registry.getDefaultName(), 'windows-safe');
  assert.equal(registry.list().some((toolset) => toolset.name === 'full-access'), false);
  assert.equal(registry.has('windows-dev'), true);
  assert.equal(registry.has('typo-dev'), false);
  assert.equal(registry.find('windows-dev')?.name, 'windows-dev');
  assert.equal(registry.get('typo-dev').name, 'windows-safe');
  assert.throws(() => registry.requireToolset('typo-dev', 'test toolset'), /Unknown test toolset: typo-dev/);
  assert.equal(registry.allowsTool('full-access', unknownTool), true);
  assert.equal(registry.allowsTool('windows-dev', shellTool), true);
  assert.equal(registry.allowsTool('windows-safe', shellTool), false);
  assert.equal(registry.allowsTool('research', webSearchTool), true);
  assert.equal(registry.allowsTool('windows-safe', webSearchTool), false);
  assert.equal(registry.allowsTool('full-access', readToolResultTool), true);
  assert.equal(registry.allowsTool('windows-dev', readToolResultTool), true);
  assert.equal(registry.allowsTool('windows-safe', readToolResultTool), true);
  assert.equal(registry.allowsTool('full-access', sendFileTool), true);
  assert.equal(registry.allowsTool('windows-dev', sendFileTool), true);
  assert.equal(registry.allowsTool('research', sendFileTool), true);
  assert.equal(registry.allowsTool('windows-safe', sendFileTool), false);
  assert.equal(registry.allowsTool('windows-safe', requestUserInputTool), true);
  assert.equal(registry.allowsTool('windows-safe', todoTool), true);
  assert.equal(registry.allowsTool('windows-dev', unknownTool), false);
  assert.equal(registry.allowsTool('research', unknownTool), false);

  const customRegistry = createToolsetRegistry('novelist-tools', [
    {
      name: 'novelist-tools',
      description: 'Custom authoring toolset',
      capabilities: ['file_read', 'tool:custom_unknown_tool'],
    },
  ]);
  assert.equal(customRegistry.getDefaultName(), 'novelist-tools');
  assert.equal(customRegistry.has('novelist-tools'), true);
  assert.equal(customRegistry.allowsTool('novelist-tools', shellTool), false);
  assert.equal(customRegistry.allowsTool('novelist-tools', unknownTool), true);
  assert.equal(customRegistry.list().some((toolset) => toolset.name === 'novelist-tools'), true);

  assert.throws(
    () =>
      createToolsetRegistry('windows-dev', [
        {
          ...DEFAULT_TOOLSETS.find((item) => item.name === 'windows-dev')!,
          description: 'attempted override',
        },
      ]),
    /Custom toolset cannot override built-in toolset/
  );

  const sanitizedConfig = new ConfigManager({
    toolsets: {
      custom: [
        {
          name: 'windows-dev',
          description: 'attempted config override',
          capabilities: ['file_read'],
        },
        {
          name: 'novelist-tools',
          description: 'Custom authoring toolset',
          capabilities: ['file_read'],
        },
      ],
    },
  }).get();
  assert.equal(sanitizedConfig.toolsets?.custom?.some((toolset) => toolset.name === 'windows-dev'), false);
  assert.equal(sanitizedConfig.toolsets?.custom?.some((toolset) => toolset.name === 'novelist-tools'), true);

  console.log('toolset-registry tests passed');
}

runAll();
