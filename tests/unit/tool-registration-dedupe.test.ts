import * as assert from 'node:assert/strict';
import {
  WebFetchTool,
  Tool,
  ToolRegistry,
  createToolResultArtifactTool,
  createWebTools,
  createToolRegistrationState,
  registerToolWithDedupe,
  resolveToolCapabilityFamilyForTool,
} from '../../src/tools/index.js';
import type { ContextManager } from '../../src/context/index.js';
import type { ToolResult } from '../../src/types.js';

class FakeTool extends Tool {
  private readonly _name: string;
  private readonly _description: string;
  private readonly _parameters: Record<string, unknown>;

  constructor(name: string, description: string, parameters: Record<string, unknown>) {
    super();
    this._name = name;
    this._description = description;
    this._parameters = parameters;
  }

  get name(): string {
    return this._name;
  }

  get description(): string {
    return this._description;
  }

  get parameters(): Record<string, unknown> {
    return this._parameters;
  }

  async execute(): Promise<ToolResult> {
    return {
      success: true,
      content: 'ok',
    };
  }
}

function testCoreWebToolsRegisterOnlyFetchByDefault(): void {
  const registry = new ToolRegistry();
  const state = createToolRegistrationState();

  const fetchUrl = registerToolWithDedupe(registry, state, new WebFetchTool(), 'core');

  assert.equal(fetchUrl.skipped, false);
  assert.equal(registry.has('web_search'), false);
  assert.equal(registry.has('web_fetch'), true);
}

function testMcpSearchCapabilityInferenceRemainsForExplicitTools(): void {
  const registry = new ToolRegistry();
  const state = createToolRegistrationState();

  const mcpSearch = new FakeTool(
    'internet_lookup',
    'Search web results by query',
    {
      type: 'object',
      properties: {
        query: { type: 'string' },
      },
      required: ['query'],
    }
  );

  assert.equal(resolveToolCapabilityFamilyForTool(mcpSearch), 'web_search');
  const registered = registerToolWithDedupe(registry, state, mcpSearch, 'team');
  assert.equal(registered.skipped, false);
  assert.equal(registered.replaced, undefined);
  assert.equal(registry.has('internet_lookup'), true);
}

function testSameNameMcpSearchCanBeExplicitlyRegistered(): void {
  const registry = new ToolRegistry();
  const state = createToolRegistrationState();

  const mcpSearch = new FakeTool(
    'web_search',
    'MCP search web results by query',
    {
      type: 'object',
      properties: {
        query: { type: 'string' },
      },
      required: ['query'],
    }
  );

  const registered = registerToolWithDedupe(registry, state, mcpSearch, 'team');
  assert.equal(registered.skipped, false);
  assert.equal(registered.replaced, undefined);
  assert.equal(registry.get('web_search')?.description, 'MCP search web results by query');
}

function testUnknownMcpToolDoesNotGetMisclassified(): void {
  const registry = new ToolRegistry();
  const state = createToolRegistrationState();
  registerToolWithDedupe(registry, state, new WebFetchTool(), 'core');

  const unrelatedUrlTool = new FakeTool(
    'url_qr_code',
    'Generate a QR code image from a URL input',
    {
      type: 'object',
      properties: {
        url: { type: 'string' },
      },
      required: ['url'],
    }
  );

  assert.equal(resolveToolCapabilityFamilyForTool(unrelatedUrlTool), 'tool:url_qr_code');
  const applied = registerToolWithDedupe(registry, state, unrelatedUrlTool, 'team');
  assert.equal(applied.skipped, false);
  assert.equal(registry.has('web_fetch'), true);
  assert.equal(registry.has('url_qr_code'), true);
}

function testWebToolDescriptionsStayStable(): void {
  const fetchUrl = new WebFetchTool();

  assert.match(fetchUrl.description, /http\/https URL/i);
  assert.match(fetchUrl.description, /Output is truncated/i);
}

function testCreateWebToolsReturnsProtocolNamedTools(): void {
  const registry = new ToolRegistry();
  const state = createToolRegistrationState();

  const tools = createWebTools();
  assert.equal(tools.length, 1);
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ['web_fetch']
  );
  for (const tool of tools) {
    registerToolWithDedupe(registry, state, tool, 'core');
  }

  assert.equal(registry.has('web_search'), false);
  assert.equal(registry.has('web_fetch'), true);
  assert.equal(registry.has('SearchWeb'), false);
  assert.equal(registry.has('FetchURL'), false);
}

function testToolResultArtifactDoesNotConflictWithFileReadCapability(): void {
  const registry = new ToolRegistry();
  const state = createToolRegistrationState();
  const readFile = new FakeTool(
    'read_file',
    'Read a file from the workspace.',
    {
      type: 'object',
      properties: {
        path: { type: 'string' },
      },
      required: ['path'],
    }
  );
  const readToolResult = createToolResultArtifactTool({
    contextManager: {
      readToolResultArtifact: async () => ({
        success: true,
        content: 'artifact window',
      }),
    } as unknown as ContextManager,
    resolveActiveContext: () => ({ scope: 'session', namespace: 'test-session' }),
  });

  assert.equal(resolveToolCapabilityFamilyForTool(readFile), 'file_read');
  assert.equal(resolveToolCapabilityFamilyForTool(readToolResult), 'tool_result_read');
  assert.equal(registerToolWithDedupe(registry, state, readFile, 'core').skipped, false);
  assert.equal(registerToolWithDedupe(registry, state, readToolResult, 'core').skipped, false);
  assert.equal(registry.has('read_file'), true);
  assert.equal(registry.has('read_tool_result'), true);
}

function runAll(): void {
  testCoreWebToolsRegisterOnlyFetchByDefault();
  testMcpSearchCapabilityInferenceRemainsForExplicitTools();
  testSameNameMcpSearchCanBeExplicitlyRegistered();
  testUnknownMcpToolDoesNotGetMisclassified();
  testWebToolDescriptionsStayStable();
  testCreateWebToolsReturnsProtocolNamedTools();
  testToolResultArtifactDoesNotConflictWithFileReadCapability();
  console.log('tool-registration-dedupe tests passed');
}

runAll();
