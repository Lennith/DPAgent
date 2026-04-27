import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ConfigManager } from '../../src/config/ConfigManager.js';
import { MiniMaxAgent } from '../../src/index.js';
import type { ContextRef } from '../../src/types.js';

const DONE_MARKER = '\u3010\u5b8c\u6210\uff01\u3011';
const REPORT_END_MARKER = '\u3010\u6c47\u62a5\u7ed3\u675f\uff01\u3011';

function getSchemaByName(schemas: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>, name: string) {
  const schema = schemas.find((item) => item.name === name);
  assert.ok(schema, `schema not found: ${name}`);
  return schema!;
}

function getPropertyDescription(
  schema: { inputSchema?: Record<string, unknown> },
  key: string
): string {
  const properties = (schema.inputSchema?.properties ?? {}) as Record<string, { description?: string }>;
  return String(properties[key]?.description ?? '');
}

function createHarness(): {
  tempDir: string;
  workspaceDir: string;
  runtimeDir: string;
  contextDir: string;
} {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'execution-tool-registry-'));
  const workspaceDir = path.join(tempDir, 'workspace');
  const runtimeDir = path.join(tempDir, 'runtime');
  const contextDir = path.join(tempDir, 'contexts');
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.mkdirSync(contextDir, { recursive: true });
  fs.mkdirSync(path.join(workspaceDir, 'skills', 'release-helper'), { recursive: true });
  fs.writeFileSync(
    path.join(workspaceDir, 'skills', 'release-helper', 'SKILL.md'),
    [
      '---',
      'name: "release-helper"',
      'description: "Workspace release helper"',
      'metadata:',
      '  tags: ["release", "workspace"]',
      '  platforms: ["windows"]',
      '---',
      '',
      'Detailed release steps that should stay out of the runtime catalog prompt.',
      '',
    ].join('\n'),
    'utf-8'
  );
  return { tempDir, workspaceDir, runtimeDir, contextDir };
}

function cleanup(tempDir: string): void {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

async function runCase(): Promise<void> {
  const harness = createHarness();
  try {
    const basePrompt = new ConfigManager().getDefaultSystemPrompt();
    assert.match(basePrompt, /reusable procedures, not durable facts/i);
    assert.match(basePrompt, /verified, reusable, and likely to help again/i);
    assert.match(basePrompt, /Use context_manage for current structured context and runtime context state/i);
    assert.match(basePrompt, /session_search for raw prior-session transcript recall/i);
    assert.match(basePrompt, /\[MANDATORY_EXECUTION_RULES\]/);
    assert.match(basePrompt, /SAYING YOU WILL DO IT DOES NOT COUNT AS DOING IT/i);
    assert.match(basePrompt, /After writing code, run the relevant code, tests, build, or verification step/i);
    assert.match(basePrompt, /After running code, inspect the actual result/i);
    assert.doesNotMatch(basePrompt, new RegExp(DONE_MARKER));
    assert.doesNotMatch(basePrompt, new RegExp(REPORT_END_MARKER));
    assert.doesNotMatch(basePrompt, /approve|reject|list_pending|create draft/i);
    assert.doesNotMatch(basePrompt, /Inspect candidate skills before inventing a workflow\./);
    assert.doesNotMatch(basePrompt, /Capture verified, reusable workflows as skill drafts/i);

    const agent = new MiniMaxAgent({
      allowMissingApiKeyAtBoot: true,
      configPath: path.join(process.cwd(), 'config.yaml'),
      workspaceDir: harness.workspaceDir,
      runtimeDataDir: harness.runtimeDir,
      contextDir: harness.contextDir,
    });
    await agent.initialize();

    const context: ContextRef = { scope: 'session', namespace: 'tool-registry-session' };
    agent.updateContextNamespaceMeta(context, { workspaceDir: harness.workspaceDir });

    const turnPrompt = (agent as any).buildTurnSystemPrompt({
      workspaceDir: harness.workspaceDir,
      context,
      additionalSystemPrompt: '',
      systemSegment: '## Context Snapshot\nnamespace=tool-registry-session',
    });
    assert.match(String(turnPrompt), /\[MANDATORY_EXECUTION_RULES\]/);
    assert.match(String(turnPrompt), /## Execution Reminder/);
    assert.match(String(turnPrompt), /Apply `\[MANDATORY_EXECUTION_RULES\]` strictly in this turn/i);
    assert.doesNotMatch(String(turnPrompt), /tail marker/i);
    assert.doesNotMatch(String(turnPrompt), new RegExp(DONE_MARKER));
    assert.doesNotMatch(String(turnPrompt), new RegExp(REPORT_END_MARKER));
    assert.doesNotMatch(String(turnPrompt), /Do not stop with progress-only text/i);

    agent.updateConfig({
      agent: {
        ...agent.getConfig().agent,
        completionMarkerEnforcementEnabled: true,
      },
    });
    const turnPromptWithMarker = (agent as any).buildTurnSystemPrompt({
      workspaceDir: harness.workspaceDir,
      context,
      additionalSystemPrompt: '',
      systemSegment: '## Context Snapshot\nnamespace=tool-registry-session',
    });
    assert.match(String(turnPromptWithMarker), /tail marker/i);
    assert.match(String(turnPromptWithMarker), new RegExp(DONE_MARKER));
    assert.match(String(turnPromptWithMarker), new RegExp(REPORT_END_MARKER));

    assert.equal(agent.resolveToolsetName(context), 'full-access');
    assert.equal(agent.getToolsetPresetStore().getWorkspacePreset(harness.workspaceDir)?.toolsetName, 'full-access');

    const registry = (agent as any).buildExecutionToolRegistry({
      context,
      turnId: 'turn-1',
      workspaceDir: harness.workspaceDir,
      includeContextManage: true,
      includeSubAgentManage: true,
    });
    const tools = registry.getAll();
    const names = tools.map((tool: { name: string }) => tool.name);
    const schemas = registry.getSchemas();

    assert.ok(names.length >= 17);
    assert.equal(new Set(names).size, names.length);
    assert.equal(names.filter((name: string) => name === 'web_search').length, 1);
    assert.equal(names.filter((name: string) => name === 'web_fetch').length, 1);
    assert.equal(names.includes('context_manage'), true);
    assert.equal(names.includes('read_tool_result'), true);
    assert.equal(names.includes('skill_manage'), true);
    assert.equal(names.includes('memory_manage'), true);
    assert.equal(names.includes('session_search'), true);
    assert.equal(names.includes('todo'), true);
    assert.equal(names.includes('clarify'), false);
    assert.equal(names.includes('request_user_input'), false);

    const subAgentRegistry = (agent as any).createSubAgentExecutionToolRegistry(
      context,
      'turn-subagent',
      harness.workspaceDir
    );
    const subAgentNames = subAgentRegistry.getAll().map((tool: { name: string }) => tool.name);
    assert.equal(subAgentNames.includes('todo'), false);
    assert.equal(subAgentNames.includes('read_tool_result'), true);

    const restrictedSubAgentRegistry = (agent as any).createSubAgentExecutionToolRegistry(
      context,
      'turn-subagent-restricted',
      harness.workspaceDir,
      ['read_file']
    );
    const restrictedSubAgentNames = restrictedSubAgentRegistry.getAll().map((tool: { name: string }) => tool.name);
    assert.equal(restrictedSubAgentNames.includes('read_file'), true);
    assert.equal(restrictedSubAgentNames.includes('read_tool_result'), false);
    assert.equal(restrictedSubAgentNames.includes('context_manage'), false);
    assert.equal(restrictedSubAgentNames.includes('subagent_manage'), false);

    const memoryTool = tools.find((tool: { name: string }) => tool.name === 'memory_manage');
    const sessionSearchTool = tools.find((tool: { name: string }) => tool.name === 'session_search');
    assert.ok(memoryTool);
    assert.ok(sessionSearchTool);
    assert.match(String((memoryTool as { description?: string }).description ?? ''), /stable preferences/i);
    assert.match(String((memoryTool as { description?: string }).description ?? ''), /raw logs/i);
    assert.match(String((memoryTool as { description?: string }).description ?? ''), /temporary workarounds/i);
    assert.match(String((memoryTool as { description?: string }).description ?? ''), /one-off outputs/i);
    assert.match(String((memoryTool as { description?: string }).description ?? ''), /structured context/i);
    assert.match(String((memoryTool as { description?: string }).description ?? ''), /context_manage/i);
    assert.match(
      String((sessionSearchTool as { description?: string }).description ?? ''),
      /prior (task context|session transcript recall)/i
    );
    assert.match(String((sessionSearchTool as { description?: string }).description ?? ''), /memory_manage separately/i);
    assert.match(String((sessionSearchTool as { description?: string }).description ?? ''), /context_manage/i);

    const skillsListSchema = schemas.find((schema) => schema.name === 'skills_list');
    const skillsViewSchema = schemas.find((schema) => schema.name === 'skills_view');
    const skillManageSchema = schemas.find((schema) => schema.name === 'skill_manage');
    const readFileSchema = getSchemaByName(schemas, 'read_file');
    const readToolResultSchema = getSchemaByName(schemas, 'read_tool_result');
    const editFileSchema = getSchemaByName(schemas, 'edit_file');
    const globSchema = getSchemaByName(schemas, 'glob');
    const shellSchema = getSchemaByName(schemas, 'shell_execute');
    const contextManageSchema = getSchemaByName(schemas, 'context_manage');
    const subagentManageSchema = getSchemaByName(schemas, 'subagent_manage');
    const todoSchema = getSchemaByName(schemas, 'todo');
    const fetchUrlSchema = getSchemaByName(schemas, 'web_fetch');
    assert.ok(skillsListSchema);
    assert.ok(skillsViewSchema);
    assert.ok(skillManageSchema);
    assert.match(String(readFileSchema.description ?? ''), /first 200 lines/i);
    assert.match(String(readToolResultSchema.description ?? ''), /stored tool result artifact/i);
    assert.match(getPropertyDescription(readFileSchema, 'limit'), /default 200-line cap/i);
    assert.match(getPropertyDescription(readToolResultSchema, 'artifact_id'), /TOOL_RESULT_STORED/i);
    assert.match(String(editFileSchema.description ?? ''), /first occurrence/i);
    assert.match(getPropertyDescription(editFileSchema, 'oldStr'), /unique or highly specific snippet/i);
    assert.match(String(globSchema.description ?? ''), /include directories as well as files/i);
    assert.match(getPropertyDescription(globSchema, 'path'), /Returned matches are relative to this directory/i);
    assert.match(String(shellSchema.description ?? ''), /idle-output, max-runtime, and output-size guardrails/i);
    assert.match(getPropertyDescription(shellSchema, 'timeout'), /idle-output, max-runtime, or max-output guardrails/i);
    assert.match(
      String(contextManageSchema.description ?? ''),
      /current structured context state, active-turn pending overlays, and selected runtime context state/i
    );
    assert.match(String(contextManageSchema.description ?? ''), /read-only/i);
    assert.match(String(contextManageSchema.description ?? ''), /buffered until turn commit/i);
    assert.match(getPropertyDescription(contextManageSchema, 'scope'), /For list, scope alone is sufficient/i);
    assert.match(getPropertyDescription(contextManageSchema, 'namespace'), /list ignores namespace/i);
    assert.match(getPropertyDescription(contextManageSchema, 'include_meta'), /Defaults to true/i);
    assert.match(getPropertyDescription(contextManageSchema, 'include_pending'), /active-turn pending context patches/i);
    assert.match(String(skillsListSchema?.description ?? ''), /non-trivial, domain-specific, or repeated workflow/i);
    assert.doesNotMatch(String(skillsListSchema?.description ?? ''), /skill_manage/i);
    assert.match(String(skillsViewSchema?.description ?? ''), /active toolset, or platform constraints/i);
    assert.match(String(skillManageSchema?.description ?? ''), /Submit create\/update skill drafts for review and approval/i);
    assert.match(String(skillManageSchema?.description ?? ''), /temporary workarounds/i);
    assert.match(String(skillManageSchema?.description ?? ''), /one-time outputs/i);
    assert.doesNotMatch(String(skillManageSchema?.description ?? ''), /\bpatch\b|\bdelete\b/i);
    assert.match(String(skillManageSchema?.description ?? ''), /does not promise immediate activation/i);
    assert.match(String(memoryTool?.description ?? ''), /scope selects the write target/i);
    assert.match(String(memoryTool?.description ?? ''), /not a strict inspection filter/i);
    assert.match(getPropertyDescription(getSchemaByName(schemas, 'memory_manage'), 'title'), /history can also use title to look up lineage/i);
    assert.match(getPropertyDescription(subagentManageSchema, 'allowed_tools'), /limited by the parent toolset/i);
    assert.match(getPropertyDescription(subagentManageSchema, 'allowed_tools'), /context_manage and subagent_manage are stripped/i);
    assert.match(String(todoSchema.description ?? ''), /session, workspace, or user scope/i);
    assert.match(String(todoSchema.description ?? ''), /use plan_set first to write the full remaining session plan/i);
    assert.match(getPropertyDescription(todoSchema, 'action'), /replaces the current unfinished plan in one call/i);
    assert.match(getPropertyDescription(todoSchema, 'action'), /primary multi-step planning path/i);
    assert.match(getPropertyDescription(todoSchema, 'action'), /set_status is the narrow status-change path/i);
    assert.match(getPropertyDescription(todoSchema, 'scope'), /otherwise user/i);
    assert.match(getPropertyDescription(todoSchema, 'include_completed'), /For list only/i);
    assert.match(getPropertyDescription(todoSchema, 'items'), /Required for plan_set/i);
    assert.match(getPropertyDescription(todoSchema, 'items'), /single umbrella todo/i);
    assert.equal(getPropertyDescription(todoSchema, 'id'), '');
    assert.match(getPropertyDescription(todoSchema, 'task_id'), /Todo item id/i);
    const todoItemsSchema = ((todoSchema.inputSchema?.properties ?? {}) as Record<string, { items?: Record<string, unknown> }>).items;
    const todoPlanItemProperties = (todoItemsSchema?.items?.properties ?? {}) as Record<string, { description?: string }>;
    assert.match(String(todoPlanItemProperties.status?.description ?? ''), /completed is not allowed here/i);
    assert.match(String(todoPlanItemProperties.blocked_reason?.description ?? ''), /starts as blocked/i);
    assert.match(getPropertyDescription(todoSchema, 'status'), /set_status only/i);
    assert.match(String(fetchUrlSchema.description ?? ''), /http\/https URL/i);
    assert.match(String(fetchUrlSchema.description ?? ''), /Output is truncated/i);
    assert.match(getPropertyDescription(fetchUrlSchema, 'timeout_ms'), /direct-fetch fallback path/i);

    const todoTool = registry.get('todo');
    assert.ok(todoTool);
    const planSetResult = await todoTool.execute({
      action: 'plan_set',
      items: [
        {
          work: 'Inspect the todo implementation',
          detection_standard: 'Relevant todo files are identified.',
          status: 'in_progress',
        },
        {
          work: 'Implement the bulk planning path',
          detection_standard: 'plan_set is available and tested.',
          priority: 'high',
        },
      ],
    });
    assert.equal(planSetResult.success, true);
    const planSetPayload = JSON.parse(String(planSetResult.content ?? '{}')) as {
      items?: Array<{ id?: string; status?: string }>;
    };
    assert.equal(planSetPayload.items?.length, 2);
    const activeTodoId = planSetPayload.items?.find((item) => item.status === 'in_progress')?.id;
    assert.ok(activeTodoId);

    const completedTodoResult = await todoTool.execute({
      action: 'set_status',
      task_id: activeTodoId,
      status: 'completed',
      evidence: ['plan_set created the new plan', 'active todo completed through set_status'],
    });
    assert.equal(completedTodoResult.success, true);

    const invalidClearPlanResult = await todoTool.execute({
      action: 'plan_set',
      items: [],
    });
    assert.equal(invalidClearPlanResult.success, false);
    assert.match(String(invalidClearPlanResult.error ?? ''), /cannot clear unfinished todos/i);

    const invalidPlanSetResult = await todoTool.execute({
      action: 'plan_set',
      items: [
        {
          work: 'Bad status should fail',
          detection_standard: 'The tool rejects invalid statuses.',
          status: 'done',
        },
      ],
    });
    assert.equal(invalidPlanSetResult.success, false);
    assert.match(String(invalidPlanSetResult.error ?? ''), /must be pending, in_progress, or blocked/i);

    const updateWithStatusResult = await todoTool.execute({
      action: 'update',
      task_id: activeTodoId,
      status: 'blocked',
      blocked_reason: 'should fail',
    });
    assert.equal(updateWithStatusResult.success, false);
    assert.match(String(updateWithStatusResult.error ?? ''), /use set_status for execution state changes/i);

    const setStatusWithPriorityResult = await todoTool.execute({
      action: 'set_status',
      task_id: activeTodoId,
      status: 'blocked',
      blocked_reason: 'waiting for review',
      priority: 'high',
    });
    assert.equal(setStatusWithPriorityResult.success, false);
    assert.match(String(setStatusWithPriorityResult.error ?? ''), /set_status only changes status, task_id, evidence, or blocked_reason/i);

    const setStatusWithItemsResult = await todoTool.execute({
      action: 'set_status',
      task_id: activeTodoId,
      status: 'blocked',
      blocked_reason: 'waiting for review',
      items: [
        {
          work: 'should fail',
          detection_standard: 'set_status must not accept items',
        },
      ],
    });
    assert.equal(setStatusWithItemsResult.success, false);
    assert.match(String(setStatusWithItemsResult.error ?? ''), /set_status only changes status, task_id, evidence, or blocked_reason/i);

    const turnSystemPrompt = (agent as any).buildTurnSystemPrompt({
      workspaceDir: harness.workspaceDir,
      context,
      additionalSystemPrompt: '',
      systemSegment: '',
    });
    assert.match(String(turnSystemPrompt), /context_manage/i);
    assert.match(String(turnSystemPrompt), /raw prior-session transcript recall/i);
    assert.match(String(turnSystemPrompt), /one-off outputs/i);
    assert.match(String(turnSystemPrompt), /available through context_manage/i);
    assert.match(String(turnSystemPrompt), /action="plan_set"/i);
    assert.match(String(turnSystemPrompt), /single umbrella todo/i);
    assert.match(String(turnSystemPrompt), /Use `set_status` to promote the next pending todo/i);
    assert.match(String(turnSystemPrompt), /Inspect candidate skills before inventing a workflow\./);
    assert.match(String(turnSystemPrompt), /skill_manage/);
    assert.equal(String(turnSystemPrompt).includes('Detailed release steps that should stay out of the runtime catalog prompt.'), false);

    assert.equal(
      tools.every((tool: { name: string }) => agent.getToolsetRegistry().allowsTool('full-access', tool as any)),
      true
    );

    const outsideDir = path.join(harness.tempDir, 'outside-sandbox');
    const outsideFile = path.join(outsideDir, 'outside.txt');
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(outsideFile, 'outside-ok\n', 'utf-8');

    const fullAccessReadFileTool = registry.get('read_file');
    assert.ok(fullAccessReadFileTool);
    const fullAccessReadResult = await fullAccessReadFileTool.execute({ path: outsideFile });
    assert.equal(fullAccessReadResult.success, true);
    assert.match(String(fullAccessReadResult.content ?? ''), /outside-ok/);

    const fullAccessShellTool = registry.get('shell_execute');
    assert.ok(fullAccessShellTool);
    const fullAccessShellResult = await fullAccessShellTool.execute({
      command: process.platform === 'win32' ? 'echo shell-outside-ok' : 'printf shell-outside-ok',
      cwd: outsideDir,
    });
    assert.equal(fullAccessShellResult.success, true);
    assert.match(String(fullAccessShellResult.content ?? ''), /shell-outside-ok/i);

    const restrictedContext: ContextRef = { scope: 'session', namespace: 'tool-registry-session-dev' };
    agent.updateContextNamespaceMeta(restrictedContext, {
      workspaceDir: harness.workspaceDir,
      toolsetName: 'windows-dev',
    });
    const restrictedRegistry = (agent as any).buildExecutionToolRegistry({
      context: restrictedContext,
      turnId: 'turn-dev',
      workspaceDir: harness.workspaceDir,
      includeContextManage: true,
      includeSubAgentManage: true,
    });

    const restrictedReadFileTool = restrictedRegistry.get('read_file');
    assert.ok(restrictedReadFileTool);
    const restrictedReadResult = await restrictedReadFileTool.execute({ path: outsideFile });
    assert.equal(restrictedReadResult.success, false);
    assert.match(String(restrictedReadResult.error ?? ''), /outside readable directories/i);

    const restrictedShellTool = restrictedRegistry.get('shell_execute');
    assert.ok(restrictedShellTool);
    const restrictedShellResult = await restrictedShellTool.execute({
      command: process.platform === 'win32' ? 'echo shell-outside-denied' : 'printf shell-outside-denied',
      cwd: outsideDir,
    });
    assert.equal(restrictedShellResult.success, false);
    assert.match(String(restrictedShellResult.error ?? ''), /outside readable directories|permission denied/i);

    const safeContext: ContextRef = { scope: 'session', namespace: 'tool-registry-session-safe' };
    agent.updateContextNamespaceMeta(safeContext, {
      workspaceDir: harness.workspaceDir,
      toolsetName: 'windows-safe',
    });
    assert.equal(agent.resolveToolsetName(safeContext), 'windows-safe');

    const safeRegistry = (agent as any).buildExecutionToolRegistry({
      context: safeContext,
      turnId: 'turn-safe',
      workspaceDir: harness.workspaceDir,
      includeContextManage: true,
      includeSubAgentManage: true,
    });
    const safeNames = safeRegistry.getAll().map((tool: { name: string }) => tool.name);
    const safeSchemas = safeRegistry.getSchemas();
    assert.equal(safeNames.includes('skill_manage'), false);
    assert.equal(safeSchemas.some((schema) => schema.name === 'skill_manage'), false);

    const safeTurnSystemPrompt = (agent as any).buildTurnSystemPrompt({
      workspaceDir: harness.workspaceDir,
      context: safeContext,
      additionalSystemPrompt: '',
      systemSegment: '',
    });
    assert.match(String(safeTurnSystemPrompt), /Inspect candidate skills before inventing a workflow\./);
    assert.doesNotMatch(String(safeTurnSystemPrompt), /\bskill_manage\b|create draft|\bapprove\b/i);

    const interactiveRegistry = (agent as any).buildExecutionToolRegistry({
      context,
      turnId: 'turn-interactive',
      workspaceDir: harness.workspaceDir,
      callback: {
        onRequestUserInput: async () => [],
      },
      includeContextManage: true,
      includeSubAgentManage: true,
    });
    const interactiveNames = interactiveRegistry.getAll().map((tool: { name: string }) => tool.name);
    assert.equal(interactiveNames.includes('clarify'), false);
    assert.equal(interactiveNames.filter((name: string) => name === 'request_user_input').length, 1);
    assert.equal(interactiveNames.filter((name: string) => name === 'web_search').length, 1);
    assert.equal(interactiveNames.filter((name: string) => name === 'web_fetch').length, 1);
    assert.equal(interactiveNames.includes('update_plan'), true);
    assert.equal(interactiveNames.includes('finalize_plan'), true);
  } finally {
    cleanup(harness.tempDir);
  }
}

runCase()
  .then(() => {
    console.log('execution-tool-registry-gating tests passed');
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
