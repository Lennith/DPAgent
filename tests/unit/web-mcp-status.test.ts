import * as assert from 'node:assert/strict';
import type { MCPStatusResponse } from '../../src/types.js';
import { createWebServerDouble } from './helpers/web-server-harness.js';
import { createWebServerTestConfig } from './web-server-test-config.js';
import { createResponseRecorder, createRouteAppHarness } from './helpers/web-route-harness.js';

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(() => resolve());
  });
}

function installStartTestHarness(server: any): void {
  server.automationScheduler = { start: () => undefined, stop: () => undefined };
  server.startDiagnosticsHeartbeat = () => undefined;
  server.getAsrRuntime = () => ({
    start: async () => undefined,
    getStatus: () => ({ configured: false, state: 'stopped' }),
  });
  server.server = {
    once: () => server.server,
    off: () => server.server,
    listen: (_port: number, callback: () => void) => {
      callback();
    },
  };
}

function testMcpStatusRouteReturnsAgentSnapshot(): void {
  const server = createWebServerDouble();
  const { app, getRoutes } = createRouteAppHarness();
  server.app = app;
  server.wss = { clients: new Set() };

  const expected: MCPStatusResponse = {
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
        toolCount: 3,
        retryCount: 0,
        updatedAt: '2026-04-10T00:00:00.000Z',
        disabled: false,
      },
    ],
  };

  server.agent = {
    getConfig: () => createWebServerTestConfig(),
    getMcpStatus: () => expected,
  };
  server.hasUsableApiKey = () => true;
  server.automationRoutes = { register: () => undefined };

  server.setupRoutes();
  const handler = getRoutes.get('/api/mcp/status');
  assert.ok(handler, 'expected /api/mcp/status route to be registered');
  const res = createResponseRecorder();
  handler?.({}, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.payload, expected);
}

function testMcpStatusRouteFailsWhenAgentThrows(): void {
  const server = createWebServerDouble();
  const { app, getRoutes } = createRouteAppHarness();
  server.app = app;
  server.wss = { clients: new Set() };
  server.agent = {
    getConfig: () => createWebServerTestConfig(),
    getMcpStatus: () => {
      throw new Error('status_failed');
    },
  };
  server.hasUsableApiKey = () => true;
  server.automationRoutes = { register: () => undefined };

  server.setupRoutes();
  const handler = getRoutes.get('/api/mcp/status');
  assert.ok(handler, 'expected /api/mcp/status route to be registered');
  const res = createResponseRecorder();
  handler?.({}, res);
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.payload, {
    error: 'status_failed',
    code: 'MCP_STATUS_UNAVAILABLE',
  });
}

async function testStartTriggersInitializeWhenApiKeyExists(): Promise<void> {
  const server = createWebServerDouble();
  server.port = 53721;
  let initializeCalls = 0;
  server.agent = {
    getConfig: () => createWebServerTestConfig(),
    initialize: async () => {
      initializeCalls += 1;
    },
  };
  server.hasUsableApiKey = () => true;
  installStartTestHarness(server);

  await server.start();
  await flushMicrotasks();
  assert.equal(initializeCalls, 1);
}

async function testStartSkipsInitializeWithoutApiKey(): Promise<void> {
  const server = createWebServerDouble();
  server.port = 53721;
  let initializeCalls = 0;
  server.agent = {
    getConfig: () => createWebServerTestConfig(),
    initialize: async () => {
      initializeCalls += 1;
    },
  };
  server.hasUsableApiKey = () => false;
  installStartTestHarness(server);

  await server.start();
  await flushMicrotasks();
  assert.equal(initializeCalls, 0);
}

async function testStartDoesNotBlockWhenInitializeFails(): Promise<void> {
  const server = createWebServerDouble();
  server.port = 53721;
  let initializeCalls = 0;
  server.agent = {
    getConfig: () => createWebServerTestConfig(),
    initialize: async () => {
      initializeCalls += 1;
      throw new Error('init_failed');
    },
  };
  server.hasUsableApiKey = () => true;
  installStartTestHarness(server);

  await server.start();
  await flushMicrotasks();
  assert.equal(initializeCalls, 1);
}

async function runAll(): Promise<void> {
  testMcpStatusRouteReturnsAgentSnapshot();
  testMcpStatusRouteFailsWhenAgentThrows();
  await testStartTriggersInitializeWhenApiKeyExists();
  await testStartSkipsInitializeWithoutApiKey();
  await testStartDoesNotBlockWhenInitializeFails();
  console.log('web-mcp-status tests passed');
}

runAll().catch((error) => {
  console.error(error);
  process.exit(1);
});
