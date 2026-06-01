import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { DPAgent } from '../../src/index.js';
import { createWebServer } from '../../src/web/server/WebServer.js';
import { applyArenaWorkspaceDiff, diffArenaWorkspaces } from '../../src/arena/index.js';
import type { ContextRef } from '../../src/types.js';
import { cleanupIntegrationHarness, createIntegrationHarness } from '../integration/helpers/integration-harness.js';

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Unable to allocate test port.')));
        return;
      }
      const port = address.port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function startMockOpenAiProvider(values: string[]): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    let requestCount = 0;
    const server = http.createServer((req, res) => {
      if (req.method !== 'POST' || !String(req.url ?? '').includes('/chat/completions')) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      req.resume();
      req.on('end', () => {
        const index = requestCount;
        requestCount += 1;
        const turnIndex = Math.floor(index / 2);
        const isToolRequest = index % 2 === 0;
        const send = (data: Record<string, unknown>) => {
          res.write(`data: ${JSON.stringify(data)}\n\n`);
        };
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        if (isToolRequest) {
          const value = values[turnIndex] ?? values[values.length - 1] ?? 'R0';
          send({
            id: `chatcmpl-tool-${turnIndex}`,
            object: 'chat.completion.chunk',
            choices: [{
              index: 0,
              delta: {
                tool_calls: [{
                  index: 0,
                  id: `write-${turnIndex + 1}`,
                  type: 'function',
                  function: {
                    name: 'write_file',
                    arguments: JSON.stringify({ path: 'timeline.txt', content: value }),
                  },
                }],
              },
            }],
          });
          send({
            id: `chatcmpl-tool-stop-${turnIndex}`,
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          });
        } else {
          const value = values[turnIndex] ?? values[values.length - 1] ?? 'R0';
          send({
            id: `chatcmpl-text-${turnIndex}`,
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: { content: `wrote ${value}` } }],
          });
          send({
            id: `chatcmpl-text-stop-${turnIndex}`,
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          });
        }
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      assert.equal(typeof address, 'object');
      assert.notEqual(address, null);
      resolve({
        url: `http://127.0.0.1:${address?.port}`,
        close: async () => {
          await new Promise<void>((closeResolve) => server.close(() => closeResolve()));
        },
      });
    });
  });
}

async function postRollback(baseUrl: string, sessionId: string, revisionId: string) {
  const res = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/workspace-rollback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ targetRevisionId: revisionId, reason: 'e2e rollback' }),
  });
  const payload = await res.json() as { applied?: boolean; changedFiles?: string[]; error?: string };
  assert.equal(res.status, 200, JSON.stringify(payload));
  assert.equal(payload.applied, true);
  return payload;
}

async function runCase(): Promise<void> {
  const harness = createIntegrationHarness('workspace-timeline-rollback-e2e-');
  const provider = await startMockOpenAiProvider(['R1', 'R2', 'R3']);
  const context: ContextRef = { scope: 'session', namespace: 'workspace-timeline-rollback-e2e' };
  const timelineFile = path.join(harness.workspaceDir, 'timeline.txt');
  try {
    fs.writeFileSync(
      harness.configPath,
      yaml.dump({
        llmProfiles: {
          defaultProfileId: 'scripted',
          profiles: [{
            id: 'scripted',
            name: 'Scripted',
            provider: 'openai',
            apiKey: 'test-api-key-0123456789012345',
            apiBase: provider.url,
            defaultModel: 'scripted-model',
            maxOutputTokens: 4096,
            enabled: true,
          }],
        },
        agent: {
          maxSteps: 8,
          tokenLimit: 210000,
          workspaceDir: harness.workspaceDir,
          contextDir: harness.contextDir,
          runtimeDataDir: harness.runtimeDir,
          defaultToolset: 'full-access',
        },
        tools: {
          enableFileTools: true,
          enableShell: false,
          enableWeb: false,
          shellType: 'powershell',
          shellTimeout: 30000,
        },
        mcp: { enabled: false, servers: [], connectTimeout: 10, executeTimeout: 60 },
        workspaceTimeline: {
          enabled: true,
          captureMode: 'advisory',
          retainedStageTurns: 5,
          gitPrivateRefs: false,
        },
      }, { lineWidth: -1 }),
      'utf-8'
    );

    const agent = new DPAgent({
      configPath: harness.configPath,
      workspaceDir: harness.workspaceDir,
      runtimeDataDir: harness.runtimeDir,
      contextDir: harness.contextDir,
      allowMissingApiKeyAtBoot: false,
    });

    for (const prompt of ['write R1', 'write R2', 'write R3']) {
      await agent.runWithResult({
        context,
        workspaceDir: harness.workspaceDir,
        prompt,
        agentRuntimeOverrides: { toolsetName: 'full-access' },
      });
    }
    assert.equal(fs.readFileSync(timelineFile, 'utf-8'), 'R3');
    const timeline = agent.getWorkspaceTimelineStore().listSessionTimeline(context.namespace);
    assert.equal(timeline.deltas.length, 3);
    const revisionsByTurn = new Map(timeline.deltas.map((delta) => [delta.turnId, delta.resultRevisionId]));
    const chronological = [...timeline.deltas].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const r1 = chronological[0]?.resultRevisionId;
    const r2 = chronological[1]?.resultRevisionId;
    const r3 = chronological[2]?.resultRevisionId;
    assert.ok(r1 && r2 && r3);
    assert.equal(new Set([r1, r2, r3]).size, 3);
    assert.equal(revisionsByTurn.size, 3);

    const branchDir = path.join(harness.tempDir, 'arena-winner-branch');
    fs.cpSync(harness.workspaceDir, branchDir, { recursive: true });
    fs.writeFileSync(path.join(branchDir, 'timeline.txt'), 'ARENA_WINNER', 'utf-8');
    fs.writeFileSync(path.join(branchDir, 'arena-winner.txt'), 'winner-only', 'utf-8');
    const proposal = diffArenaWorkspaces(harness.workspaceDir, branchDir);
    applyArenaWorkspaceDiff({
      sourceDir: harness.workspaceDir,
      branchDir,
      changedFiles: proposal.changedFiles,
      expectedSourceHash: proposal.sourceHash,
      expectedBranchHash: proposal.branchHash,
    });
    assert.equal(fs.readFileSync(timelineFile, 'utf-8'), 'ARENA_WINNER');
    assert.equal(fs.readFileSync(path.join(harness.workspaceDir, 'arena-winner.txt'), 'utf-8'), 'winner-only');

    const port = await getFreePort();
    const server = createWebServer({ port, configPath: harness.configPath });
    try {
      await server.start();
      const baseUrl = `http://127.0.0.1:${port}`;

      await postRollback(baseUrl, context.namespace, r2);
      assert.equal(fs.readFileSync(timelineFile, 'utf-8'), 'R2');
      assert.equal(fs.existsSync(path.join(harness.workspaceDir, 'arena-winner.txt')), false);

      await postRollback(baseUrl, context.namespace, r1);
      assert.equal(fs.readFileSync(timelineFile, 'utf-8'), 'R1');

      await postRollback(baseUrl, context.namespace, r3);
      assert.equal(fs.readFileSync(timelineFile, 'utf-8'), 'R3');

      const apiTimeline = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(context.namespace)}/workspace-timeline`);
      assert.equal(apiTimeline.status, 200);
      const timelinePayload = await apiTimeline.json() as { timeline?: { deltas?: unknown[] } };
      assert.equal(timelinePayload.timeline?.deltas?.length, 3);
    } finally {
      await server.stop().catch(() => undefined);
    }

    const load = agent.getContextManager().loadForTurn(context);
    assert.match(load.systemSegment, /workspaceTimeline\.currentRevision/);
    assert.match(load.systemSegment, new RegExp(r3));
    assert.match(load.systemSegment, /workspaceTimeline\.lastRollback/);
    assert.match(load.systemSegment, /e2e rollback/);
    assert.equal(load.projection.version, 3);
    assert.equal(agent.getContextManager().getEventStore().readEvents(context.scope, context.namespace).filter((event) => event.type === 'turn_committed').length, 3);

    console.log('workspace-timeline rollback e2e passed');
  } finally {
    await provider.close().catch(() => undefined);
    cleanupIntegrationHarness(harness);
  }
}

runCase().catch((error) => {
  console.error(error);
  process.exit(1);
});
