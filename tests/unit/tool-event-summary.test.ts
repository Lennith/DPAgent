import * as assert from 'node:assert/strict';
import {
  summarizeToolCall,
  summarizeToolResult,
} from '../../src/web/client/components/chat/toolEventSummary.js';

function runAll(): void {
  const callSummary = summarizeToolCall('context_manage', {
    action: 'read',
    key: 'build.status',
  });
  assert.equal(callSummary.title, 'Context read');
  assert.match(callSummary.subtitle, /build\.status/i);

  const resultSummary = summarizeToolResult('context_manage', {
    success: true,
    content: JSON.stringify({
      ok: true,
      action: 'list',
      namespaces: [{ namespace: 'sess-1' }, { namespace: 'sess-2' }],
    }),
  });
  assert.equal(resultSummary.title, 'Context list succeeded');
  assert.match(resultSummary.subtitle, /2 namespaces returned/i);

  const todoPlanCallSummary = summarizeToolCall('todo', {
    action: 'plan_set',
    items: [
      {
        work: 'Inspect current implementation',
        detection_standard: 'Relevant files are identified.',
      },
      {
        work: 'Patch the todo flow',
        detection_standard: 'The new todo protocol is wired.',
      },
    ],
  });
  assert.equal(todoPlanCallSummary.title, 'Todo plan_set');
  assert.match(todoPlanCallSummary.subtitle, /2 planned items/i);
  assert.match(todoPlanCallSummary.subtitle, /Inspect current implementation/i);

  const todoPlanResultSummary = summarizeToolResult('todo', {
    success: true,
    content: JSON.stringify({
      ok: true,
      action: 'plan_set',
      items: [{ id: 'todo-1' }, { id: 'todo-2' }],
    }),
  });
  assert.equal(todoPlanResultSummary.title, 'Todo plan_set succeeded');
  assert.match(todoPlanResultSummary.subtitle, /Plan replaced with 2 todo items/i);

  console.log('tool-event-summary tests passed');
}

runAll();
