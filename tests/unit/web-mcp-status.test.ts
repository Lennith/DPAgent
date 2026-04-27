import * as assert from 'node:assert/strict';
import { WebServer } from '../../src/web/server/WebServer.js';
import type { MCPStatusResponse } from '../../src/types.js';

type RouteHandler = (req: unknown, res: unknown) => void;

function createAppHarness() {
  const routes = new Map<string, RouteHandler>();
  const app = {
    use: () => undefined,
    get: (route: string, handler: RouteHandler) => {
      routes.set(route, handler);
    },
    post: () => undefined,
    put: () => undefined,
    patch: () => undefined,
    delete: () => undefined,
  };
  return { app, routes };
}

function createResponseRecorder() {
  const recorder = {
    statusCode: 200,
    payload: undefined as unknown,
    status(code: number) {
      recorder.statusCode = code;
      return recorder;
    },
    json(data: unknown) {
      recorder.payload = data;
      return recorder;
    },
  };
  return recorder;
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(() => resolve());
  });
}

function testMcpStatusRouteReturnsAgentSnapshot(): void {
  const server = Object.create(WebServer.prototype) as any;
  const { app, routes } = createAppHarness();
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
    getMcpStatus: () => expected,
  };
  server.hasUsableApiKey = () => true;
  server.automationRoutes = { register: () => undefined };

  server.setupRoutes();
  const handler = routes.get('/api/mcp/status');
  assert.ok(handler, 'expected /api/mcp/status route to be registered');
  const res = createResponseRecorder();
  handler?.({}, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.payload, expected);
}

function testMcpStatusRouteReturnsFallbackWhenAgentThrows(): void {
  const server = Object.create(WebServer.prototype) as any;
  const { app, routes } = createAppHarness();
  server.app = app;
  server.wss = { clients: new Set() };
  server.agent = {
    getMcpStatus: () => {
      throw new Error('status_failed');
    },
  };
  server.hasUsableApiKey = () => true;
  server.automationRoutes = { register: () => undefined };

  server.setupRoutes();
  const handler = routes.get('/api/mcp/status');
  assert.ok(handler, 'expected /api/mcp/status route to be registered');
  const res = createResponseRecorder();
  handler?.({}, res);
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.payload, {
    enabled: false,
    summary: {
      state: 'disabled',
      connectedCount: 0,
      totalEnabled: 0,
    },
    servers: [],
  });
}

async function testStartTriggersInitializeWhenApiKeyExists(): Promise<void> {
  const server = Object.create(WebServer.prototype) as any;
  server.port = 53721;
  let initializeCalls = 0;
  server.agent = {
    initialize: async () => {
      initializeCalls += 1;
    },
  };
  server.hasUsableApiKey = () => true;
  server.automationScheduler = { start: () => undefined, stop: () => undefined };
  server.server = {
    listen: (_port: number, callback: () => void) => {
      callback();
    },
  };

  await server.start();
  await flushMicrotasks();
  assert.equal(initializeCalls, 1);
}

async function testStartSkipsInitializeWithoutApiKey(): Promise<void> {
  const server = Object.create(WebServer.prototype) as any;
  server.port = 53721;
  let initializeCalls = 0;
  server.agent = {
    initialize: async () => {
      initializeCalls += 1;
    },
  };
  server.hasUsableApiKey = () => false;
  server.automationScheduler = { start: () => undefined, stop: () => undefined };
  server.server = {
    listen: (_port: number, callback: () => void) => {
      callback();
    },
  };

  await server.start();
  await flushMicrotasks();
  assert.equal(initializeCalls, 0);
}

async function testStartDoesNotBlockWhenInitializeFails(): Promise<void> {
  const server = Object.create(WebServer.prototype) as any;
  server.port = 53721;
  let initializeCalls = 0;
  server.agent = {
    initialize: async () => {
      initializeCalls += 1;
      throw new Error('init_failed');
    },
  };
  server.hasUsableApiKey = () => true;
  server.automationScheduler = { start: () => undefined, stop: () => undefined };
  server.server = {
    listen: (_port: number, callback: () => void) => {
      callback();
    },
  };

  await server.start();
  await flushMicrotasks();
  assert.equal(initializeCalls, 1);
}

async function runAll(): Promise<void> {
  testMcpStatusRouteReturnsAgentSnapshot();
  testMcpStatusRouteReturnsFallbackWhenAgentThrows();
  await testStartTriggersInitializeWhenApiKeyExists();
  await testStartSkipsInitializeWithoutApiKey();
  await testStartDoesNotBlockWhenInitializeFails();
  console.log('web-mcp-status tests passed');
}

runAll().catch((error) => {
  console.error(error);
  process.exit(1);
});
