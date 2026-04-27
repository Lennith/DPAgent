import assert from 'node:assert/strict';
import { ContextPayloadProjector } from '../../src/context/ContextPayloadProjector.js';
import type { Message } from '../../src/types.js';

function testArtifactToolResultIsProjectedToStableRef(): void {
  const projector = new ContextPayloadProjector();
  const hugePreview = 'artifact-preview-line\n'.repeat(1000);
  const messages: Message[] = [
    { role: 'user', content: 'inspect output' },
    {
      role: 'assistant',
      content: 'reading output',
      toolCalls: [
        {
          id: 'call-large',
          type: 'function',
          function: { name: 'shell_execute', arguments: { command: 'build' } },
        },
      ],
    },
    {
      role: 'tool',
      name: 'shell_execute',
      toolCallId: 'call-large',
      content:
        '[TOOL_RESULT_STORED tool=shell_execute tool_call_id=call-large artifact_id=artifact-large original_chars=90000 preview_chars=3000]\n\nPreview:\n' +
        hugePreview,
      metadata: {
        toolResultArtifact: {
          artifactId: 'artifact-large',
          toolCallId: 'call-large',
          toolName: 'shell_execute',
          relativePath: 'tool-results/artifact-large.txt',
          originalChars: 90000,
          previewChars: 3000,
          createdAt: '2026-04-27T00:00:00.000Z',
        },
      },
    },
  ];

  const projected = projector.projectForProvider(messages, {
    systemPrompt: 'system',
    maxToolResultChars: 1200,
    trimOptions: {
      maxTotalChars: 10000,
      keepLatestCount: 10,
      maxToolChars: 1200,
      maxNonToolChars: 4000,
    },
  });

  const toolMessage = projected.messages.find((message) => message.role === 'tool');
  assert.match(String(toolMessage?.content ?? ''), /artifact_id=artifact-large/);
  assert.equal(String(toolMessage?.content ?? '').includes(hugePreview), false);
  assert.equal(projected.metrics.toolResultRefReplacements, 1);
  assert.equal(projected.metrics.preparedChars < projected.metrics.originalChars, true);
}

function testOversizedInlineToolResultIsBudgeted(): void {
  const projector = new ContextPayloadProjector();
  const messages: Message[] = [
    { role: 'assistant', content: 'read', toolCalls: [{ id: 'call-inline', type: 'function', function: { name: 'grep', arguments: {} } }] },
    {
      role: 'tool',
      name: 'grep',
      toolCallId: 'call-inline',
      content: 'inline-result\n'.repeat(2000),
    },
  ];

  const projected = projector.projectForProvider(messages, {
    maxToolResultChars: 2000,
    trimOptions: {
      maxTotalChars: 10000,
      keepLatestCount: 10,
      maxToolChars: 2000,
      maxNonToolChars: 4000,
    },
  });

  const content = String(projected.messages.find((message) => message.role === 'tool')?.content ?? '');
  assert.match(content, /TOOL_RESULT_INLINE_BUDGET_APPLIED/);
  assert.equal(content.length <= 2000, true);
  assert.equal(projected.metrics.oversizedInlineToolTruncations, 1);
}

function testProviderProjectionDoesNotTruncateNonToolInputBeforeTrim(): void {
  const projector = new ContextPayloadProjector();
  const longPrompt = 'important-user-context '.repeat(900);
  const messages: Message[] = [{ role: 'user', content: longPrompt }];

  const projected = projector.projectForProvider(messages, {
    trimOptions: {
      maxTotalChars: longPrompt.length + 1000,
      keepLatestCount: 10,
      maxToolChars: 2000,
      maxNonToolChars: 4000,
    },
  });

  assert.equal(projected.messages[0]?.content, longPrompt);
  assert.equal(String(projected.messages[0]?.content ?? '').includes('CONTEXT_PAYLOAD_TRUNCATED'), false);
}

testArtifactToolResultIsProjectedToStableRef();
testOversizedInlineToolResultIsBudgeted();
testProviderProjectionDoesNotTruncateNonToolInputBeforeTrim();
console.log('context-payload-projector tests passed');
