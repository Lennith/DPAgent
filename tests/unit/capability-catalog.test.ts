import * as assert from 'node:assert/strict';
import {
  Tool,
  ToolRegistry,
  filterSubAgentToolRegistry,
  intersectAllowedToolNames,
  normalizeAllowedToolNames,
  resolveToolCapabilityFamily,
} from '../../src/tools/index.js';
import type { ToolResult } from '../../src/types.js';

class FakeTool extends Tool {
  constructor(private readonly toolName: string) {
    super();
  }

  get name(): string {
    return this.toolName;
  }

  get description(): string {
    return this.toolName;
  }

  get parameters(): Record<string, unknown> {
    return { type: 'object', properties: {} };
  }

  async execute(): Promise<ToolResult> {
    return { success: true, content: 'ok' };
  }
}

function testCapabilityNamesStayStable(): void {
  assert.equal(resolveToolCapabilityFamily('read_file'), 'file_read');
  assert.equal(resolveToolCapabilityFamily('web_search'), 'web_search');
  assert.equal(resolveToolCapabilityFamily('schedule_task'), 'automation_manage');
  assert.equal(resolveToolCapabilityFamily('custom_tool'), 'tool:custom_tool');
}

function testAllowedToolNormalizationStripsProtectedTools(): void {
  assert.deepEqual(
    normalizeAllowedToolNames([' Read_File ', 'read_file', 'context_manage', 'subagent_manage', 'todo', 'schedule_task']),
    ['read_file']
  );
}

function testAllowedToolIntersection(): void {
  assert.deepEqual(intersectAllowedToolNames(['read_file', 'shell_execute'], ['read_file']), ['read_file']);
  assert.equal(intersectAllowedToolNames(['shell_execute'], ['read_file']), undefined);
  assert.deepEqual(intersectAllowedToolNames(['todo'], ['read_file'], { preserveEmpty: true }), []);
}

function testSubAgentRegistryFilterUsesSameProtection(): void {
  const registry = new ToolRegistry();
  for (const name of ['read_file', 'context_manage', 'subagent_manage', 'todo', 'shell_execute']) {
    registry.register(new FakeTool(name));
  }

  const filtered = filterSubAgentToolRegistry(registry, ['read_file', 'todo', 'shell_execute']);
  assert.deepEqual(
    filtered.getAll().map((tool) => tool.name),
    ['read_file', 'shell_execute']
  );

  const protectedOnly = filterSubAgentToolRegistry(registry, ['todo', 'schedule_task']);
  assert.deepEqual(protectedOnly.getAll(), []);
}

function runAll(): void {
  testCapabilityNamesStayStable();
  testAllowedToolNormalizationStripsProtectedTools();
  testAllowedToolIntersection();
  testSubAgentRegistryFilterUsesSameProtection();
  console.log('capability-catalog tests passed');
}

runAll();
