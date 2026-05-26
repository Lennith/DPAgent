import * as assert from 'node:assert/strict';
import {
  ARTIFACT_READ_MAX_SCAN_BYTES,
  buildAgentToolResultTruncatedContent,
  buildInlineToolResultBudgetContent,
  buildProjectedToolResultArtifactPayload,
  buildReadToolResultArtifactContent,
  buildRedactedToolArgumentContent,
  buildStoredToolResultContent,
  redactToolCallArgumentsForCheckpoint,
  redactToolCallMessagesForCheckpoint,
  redactToolCallsForCheckpoint,
  resolveAgentToolResultInlineChars,
  resolveArtifactReadLineLimit,
  resolveArtifactReadMaxChars,
  resolveToolResultArtifactPreviewChars,
  shouldMaterializeLiveToolResult,
} from '../../src/runtime/tool-result-payload-policy.js';
import type { ToolResultArtifactRef } from '../../src/types.js';

function createArtifact(): ToolResultArtifactRef {
  return {
    artifactId: 'artifact-1',
    toolCallId: 'call-1',
    toolName: 'shell_execute',
    relativePath: 'tool-results/artifact-1.txt',
    originalChars: 90000,
    previewChars: 3000,
    createdAt: '2026-04-28T00:00:00.000Z',
  };
}

function testInlineThresholds(): void {
  assert.equal(resolveAgentToolResultInlineChars('read_file'), 20000);
  assert.equal(resolveAgentToolResultInlineChars('read_tool_result'), 26000);
  assert.equal(resolveAgentToolResultInlineChars('shell_execute'), 4000);
  assert.equal(shouldMaterializeLiveToolResult('read_file'), true);
  assert.equal(shouldMaterializeLiveToolResult('read_tool_result'), false);
  assert.equal(shouldMaterializeLiveToolResult('shell_execute'), true);
}

function testMarkersPreserveExternalStrings(): void {
  const artifact = createArtifact();
  assert.match(buildStoredToolResultContent(artifact, 'preview'), /^\[TOOL_RESULT_STORED tool=shell_execute/);
  assert.match(
    buildProjectedToolResultArtifactPayload(artifact, 'Preview:\n' + 'x'.repeat(2000), 500),
    /artifact_id=artifact-1/
  );
  assert.match(
    buildAgentToolResultTruncatedContent('grep', 'x'.repeat(100), 80),
    /^\[TOOL_RESULT_TRUNCATED tool=grep original_chars=100 kept_chars=80\]/
  );
  assert.match(
    buildInlineToolResultBudgetContent('x'.repeat(160), 130, 'artifact failed'),
    /^\[TOOL_RESULT_INLINE_BUDGET_APPLIED original_chars=160 kept_chars=130 artifact_error="artifact failed"\]/
  );
}

function testWriteFileArgsAreRedactedForReplayAndTransport(): void {
  assert.equal(
    buildRedactedToolArgumentContent(120000),
    '[TOOL_ARGUMENT_REDACTED field=content original_chars=120000]'
  );
  const redactedArgs = redactToolCallArgumentsForCheckpoint('write_file', {
    path: 'story.txt',
    content: 'x'.repeat(120000),
    encoding: 'utf-8',
  });
  assert.deepEqual(redactedArgs, {
    path: 'story.txt',
    content: '[TOOL_ARGUMENT_REDACTED field=content original_chars=120000]',
    encoding: 'utf-8',
  });
  const toolCalls = redactToolCallsForCheckpoint([
    {
      id: 'call-write',
      type: 'function',
      function: {
        name: 'write_file',
        arguments: {
          path: 'story.txt',
          content: 'hello',
        },
      },
    },
  ]);
  assert.equal(toolCalls?.[0]?.function.arguments.content, '[TOOL_ARGUMENT_REDACTED field=content original_chars=5]');
  const [message] = redactToolCallMessagesForCheckpoint([
    {
      role: 'assistant',
      content: 'Writing file',
      toolCalls: [
        {
          id: 'call-write-message',
          type: 'function',
          function: {
            name: 'write_file',
            arguments: {
              path: 'large.txt',
              content: 'x'.repeat(12),
            },
          },
        },
      ],
    },
  ]);
  assert.equal(message?.toolCalls?.[0]?.function.arguments.content, '[TOOL_ARGUMENT_REDACTED field=content original_chars=12]');
}

function testArtifactReadBounds(): void {
  assert.equal(resolveToolResultArtifactPreviewChars(1), 200);
  assert.equal(resolveToolResultArtifactPreviewChars(20000), 20000);
  assert.equal(resolveArtifactReadLineLimit(undefined), 400);
  assert.equal(resolveArtifactReadLineLimit(999), 400);
  assert.equal(resolveArtifactReadMaxChars(undefined), 20000);
  assert.equal(resolveArtifactReadMaxChars(999999), 24000);
  assert.match(
    buildReadToolResultArtifactContent({
      artifactId: 'artifact-1',
      offset: 0,
      limit: 400,
      maxChars: 20000,
      maxScanBytes: ARTIFACT_READ_MAX_SCAN_BYTES,
      content: 'window',
    }),
    /^\[TOOL_RESULT_ARTIFACT artifact_id=artifact-1 offset=0 limit=400 max_chars=20000 max_scan_bytes=8388608\]/
  );
  const fullDefaultReadMessage = buildReadToolResultArtifactContent({
    artifactId: 'artifact-1',
    offset: 0,
    limit: 400,
    maxChars: 20000,
    maxScanBytes: ARTIFACT_READ_MAX_SCAN_BYTES,
    content: 'x'.repeat(20000),
  });
  assert.ok(fullDefaultReadMessage.length < resolveAgentToolResultInlineChars('read_tool_result'));
}

testInlineThresholds();
testMarkersPreserveExternalStrings();
testArtifactReadBounds();
testWriteFileArgsAreRedactedForReplayAndTransport();
console.log('tool-result-payload-policy tests passed');
