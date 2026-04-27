import * as assert from 'node:assert/strict';
import { Tool, ToolsetRegistry } from '../../src/tools/index.js';
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
  const requestUserInputTool = new FakeTool('request_user_input', 'request user input');
  const todoTool = new FakeTool('todo', 'todo');
  const unknownTool = new FakeTool('custom_unknown_tool', 'custom');

  assert.equal(registry.getDefaultName(), 'full-access');
  assert.equal(registry.list().some((toolset) => toolset.name === 'full-access'), false);
  assert.equal(registry.allowsTool('full-access', unknownTool), true);
  assert.equal(registry.allowsTool('windows-dev', shellTool), true);
  assert.equal(registry.allowsTool('windows-safe', shellTool), false);
  assert.equal(registry.allowsTool('research', webSearchTool), true);
  assert.equal(registry.allowsTool('windows-safe', webSearchTool), false);
  assert.equal(registry.allowsTool('full-access', readToolResultTool), true);
  assert.equal(registry.allowsTool('windows-dev', readToolResultTool), true);
  assert.equal(registry.allowsTool('windows-safe', readToolResultTool), true);
  assert.equal(registry.allowsTool('windows-safe', requestUserInputTool), true);
  assert.equal(registry.allowsTool('windows-safe', todoTool), true);
  assert.equal(registry.allowsTool('windows-dev', unknownTool), false);
  assert.equal(registry.allowsTool('research', unknownTool), false);

  console.log('toolset-registry tests passed');
}

runAll();
