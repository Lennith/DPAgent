import * as assert from 'node:assert/strict';
import {
  buildMcpIndicatorLabel,
  normalizeMcpStatus,
  resolveMcpIndicatorState,
} from '../../src/web/client/mcp-status.js';

function testNormalizeMcpStatusWithValidPayload(): void {
  const status = normalizeMcpStatus({
    enabled: true,
    summary: {
      state: 'connected',
      connectedCount: 1,
      totalEnabled: 1,
    },
    servers: [
      {
        name: 'MiniMax-Coding-Plan',
        status: 'connected',
        toolCount: 6,
        retryCount: 0,
        lastError: '',
        updatedAt: '2026-04-10T00:00:00.000Z',
        disabled: false,
      },
    ],
  });
  assert.equal(status.enabled, true);
  assert.equal(status.summary.state, 'connected');
  assert.equal(status.servers[0]?.name, 'MiniMax-Coding-Plan');
  assert.equal(status.servers[0]?.status, 'connected');
}

function testNormalizeMcpStatusFallsBackForInvalidInput(): void {
  const status = normalizeMcpStatus('invalid');
  assert.equal(status.enabled, false);
  assert.equal(status.summary.state, 'idle');
  assert.equal(status.servers.length, 0);
}

function testResolveMcpIndicatorStateMapping(): void {
  assert.equal(resolveMcpIndicatorState(null), 'idle');
  assert.equal(
    resolveMcpIndicatorState(
      normalizeMcpStatus({
        enabled: false,
        summary: { state: 'disabled', connectedCount: 0, totalEnabled: 0 },
      })
    ),
    'disabled'
  );
  assert.equal(
    resolveMcpIndicatorState(
      normalizeMcpStatus({
        enabled: true,
        summary: { state: 'connected', connectedCount: 1, totalEnabled: 2 },
      })
    ),
    'connected'
  );
  assert.equal(
    resolveMcpIndicatorState(
      normalizeMcpStatus({
        enabled: true,
        summary: { state: 'degraded', connectedCount: 0, totalEnabled: 1 },
      })
    ),
    'degraded'
  );
}

function testBuildMcpIndicatorLabel(): void {
  assert.equal(buildMcpIndicatorLabel(null), 'MCP idle');
  assert.equal(
    buildMcpIndicatorLabel(
      normalizeMcpStatus({
        enabled: true,
        summary: { state: 'connected', connectedCount: 1, totalEnabled: 1 },
      })
    ),
    'MCP connected (1/1)'
  );
  assert.equal(
    buildMcpIndicatorLabel(
      normalizeMcpStatus({
        enabled: true,
        summary: { state: 'degraded', connectedCount: 0, totalEnabled: 1 },
      })
    ),
    'MCP degraded'
  );
  assert.equal(
    buildMcpIndicatorLabel(
      normalizeMcpStatus({
        enabled: false,
        summary: { state: 'disabled', connectedCount: 0, totalEnabled: 0 },
      })
    ),
    'MCP disabled'
  );
}

function runAll(): void {
  testNormalizeMcpStatusWithValidPayload();
  testNormalizeMcpStatusFallsBackForInvalidInput();
  testResolveMcpIndicatorStateMapping();
  testBuildMcpIndicatorLabel();
  console.log('mcp-status-ui tests passed');
}

runAll();
