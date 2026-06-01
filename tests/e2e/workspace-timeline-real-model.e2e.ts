import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { DPAgent } from '../../src/index.js';
import { createWebServer } from '../../src/web/server/WebServer.js';
import type { ContextRef } from '../../src/types.js';
import { cleanupIntegrationHarness, createIntegrationHarness } from '../integration/helpers/integration-harness.js';

interface RealProfile {
  id: string;
  label: string;
  name?: string;
  provider: 'anthropic' | 'openai';
  apiKey?: string;
  apiKeyEnv?: string;
  apiBase: string;
  model?: string;
  maxOutputTokens?: number;
}

function readLocalProfiles(repoRoot: string): RealProfile[] {
  const profilePath = path.join(repoRoot, 'release-toolcall-profiles.local.json');
  if (!fs.existsSync(profilePath)) {
    return [];
  }
  const loaded = JSON.parse(fs.readFileSync(profilePath, 'utf-8')) as { profiles?: RealProfile[] };
  return Array.isArray(loaded.profiles) ? loaded.profiles : [];
}

function resolveRealProfile(repoRoot: string): RealProfile {
  const requested = String(process.env.WORKSPACE_TIMELINE_E2E_PROFILE || 'deepseek').trim().toLowerCase();
  const local = readLocalProfiles(repoRoot);
  const found = local.find((profile) => profile.label?.toLowerCase() === requested || profile.id?.toLowerCase() === requested);
  const envKey = process.env.WORKSPACE_TIMELINE_E2E_API_KEY || process.env.RELEASE_XIAOMI_MIMO_API_KEY || '';
  const envProfile: RealProfile = {
    id: `workspace-timeline-${requested}`,
    label: requested,
    provider: 'anthropic',
    apiKey: envKey,
    apiBase: requested === 'xiaomi'
      ? 'https://token-plan-cn.xiaomimimo.com/anthropic'
      : 'https://api.minimaxi.com',
    model: requested === 'xiaomi' ? 'mimo-v2.5-pro' : requested === 'minimax' ? 'MiniMax-M2.7-highspeed' : 'deepseek-v4-flash',
    maxOutputTokens: 32768,
  };
  const profile = found ?? envProfile;
  const apiKey = String(profile.apiKey || (profile.apiKeyEnv ? process.env[profile.apiKeyEnv] : '') || '').trim();
  if (!apiKey) {
    throw new Error(
      `Workspace Timeline real E2E requires profile "${requested}" in release-toolcall-profiles.local.json or WORKSPACE_TIMELINE_E2E_API_KEY.`
    );
  }
  return {
    ...profile,
    apiKey,
    model: profile.model || envProfile.model,
    maxOutputTokens: profile.maxOutputTokens ?? 32768,
  };
}

function createConfigYaml(profile: RealProfile, workspaceDir: string, runtimeDir: string, contextDir: string): string {
  return yaml.dump({
    llmProfiles: {
      defaultProfileId: profile.id,
      profiles: [
        {
          id: profile.id,
          name: profile.name || profile.label,
          provider: profile.provider,
          apiKey: profile.apiKey,
          apiBase: profile.apiBase,
          defaultModel: profile.model,
          maxOutputTokens: profile.maxOutputTokens,
          enabled: true,
          capabilities: {
            modelDiscovery: false,
            reasoningEffort: true,
            thinkingBudget: true,
          },
        },
      ],
    },
    agent: {
      maxSteps: 8,
      tokenLimit: 210000,
      workspaceDir,
      contextDir,
      runtimeDataDir: runtimeDir,
      defaultToolset: 'full-access',
    },
    tools: {
      enableFileTools: true,
      enableShell: false,
      enableWeb: false,
      shellType: 'powershell',
      shellTimeout: 30000,
    },
    mcp: {
      enabled: false,
      servers: [],
      connectTimeout: 10,
      executeTimeout: 60,
    },
    workspaceTimeline: {
      enabled: true,
      captureMode: 'advisory',
      retainedStageTurns: 5,
      gitPrivateRefs: false,
    },
  }, { lineWidth: -1 });
}

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
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function runCase(): Promise<void> {
  const repoRoot = process.cwd();
  const profile = resolveRealProfile(repoRoot);
  const harness = createIntegrationHarness('workspace-timeline-real-e2e-');
  const context: ContextRef = { scope: 'session', namespace: 'workspace-timeline-real-e2e' };
  const targetPath = path.join(harness.workspaceDir, 'timeline-output.txt');
  const marker = `WORKSPACE_TIMELINE_E2E_${Date.now()}`;

  try {
    fs.writeFileSync(path.join(harness.workspaceDir, 'README.md'), 'Workspace Timeline real E2E fixture.\n', 'utf-8');
    fs.writeFileSync(
      harness.configPath,
      createConfigYaml(profile, harness.workspaceDir, harness.runtimeDir, harness.contextDir),
      'utf-8'
    );

    const agent = new DPAgent({
      configPath: harness.configPath,
      workspaceDir: harness.workspaceDir,
      runtimeDataDir: harness.runtimeDir,
      contextDir: harness.contextDir,
      allowMissingApiKeyAtBoot: false,
    });
    agent.updateContextNamespaceMeta(context, {
      workspaceDir: harness.workspaceDir,
      toolsetName: 'full-access',
      llmSelection: {
        profileId: profile.id,
        model: profile.model,
        reasoningPreset: 'off',
        updatedAt: new Date().toISOString(),
      },
    });

    const result = await agent.runWithResult({
      context,
      workspaceDir: harness.workspaceDir,
      prompt: [
        'This is a deterministic end-to-end test.',
        'Use the write_file tool exactly once to write timeline-output.txt in the workspace.',
        `The full file content must be exactly: ${marker}`,
        'After the tool succeeds, answer with one short sentence and do not change any other files.',
      ].join('\n'),
      agentRuntimeOverrides: {
        toolsetName: 'full-access',
        llmSelection: {
          profileId: profile.id,
          model: profile.model,
          reasoningPreset: 'off',
        },
      },
    });

    assert.equal(fs.existsSync(targetPath), true);
    assert.equal(fs.readFileSync(targetPath, 'utf-8'), marker);
    assert.equal(result.context.namespace, context.namespace);

    const timeline = agent.getWorkspaceTimelineStore().listSessionTimeline(context.namespace);
    assert.equal(timeline.deltas.length, 1);
    assert.deepEqual(timeline.deltas[0]?.changedFiles, ['timeline-output.txt']);
    assert.equal(timeline.deltas[0]?.blobState, 'available');
    assert.equal(timeline.deltas[0]?.auditOnly, true);

    const delta = agent.getWorkspaceTimelineStore().getDelta(timeline.deltas[0]!.id);
    assert.ok(delta);
    assert.equal(delta.status, 'committed');
    assert.equal(delta.entries[0]?.operation, 'add');
    assert.equal(delta.entries[0]?.next?.sha256.length, 64);

    const events = agent.getContextManager().getEventStore().readEvents(context.scope, context.namespace);
    const committed = events.find((event) => event.type === 'turn_committed');
    assert.ok(committed);
    const metadata = committed.data.workspaceTimeline as { deltaId?: string; changedFiles?: string[] } | undefined;
    assert.equal(metadata?.deltaId, delta.id);
    assert.deepEqual(metadata?.changedFiles, ['timeline-output.txt']);

    const port = await getFreePort();
    const server = createWebServer({ port, configPath: harness.configPath });
    try {
      await server.start();
      const baseUrl = `http://127.0.0.1:${port}`;
      const timelineRes = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(context.namespace)}/workspace-timeline`);
      assert.equal(timelineRes.status, 200);
      const timelinePayload = await timelineRes.json() as { success?: boolean; timeline?: { deltas?: Array<{ id: string }> } };
      assert.equal(timelinePayload.success, true);
      assert.equal(timelinePayload.timeline?.deltas?.[0]?.id, delta.id);

      const deltaRes = await fetch(
        `${baseUrl}/api/sessions/${encodeURIComponent(context.namespace)}/workspace-deltas/${encodeURIComponent(delta.id)}`
      );
      assert.equal(deltaRes.status, 200);
      const deltaPayload = await deltaRes.json() as { success?: boolean; delta?: { changedFiles?: string[]; status?: string } };
      assert.equal(deltaPayload.success, true);
      assert.deepEqual(deltaPayload.delta?.changedFiles, ['timeline-output.txt']);
      assert.equal(deltaPayload.delta?.status, 'committed');
    } finally {
      await server.stop().catch(() => undefined);
    }

    console.log(`workspace-timeline real-model e2e passed with profile=${profile.label || profile.id}`);
  } finally {
    cleanupIntegrationHarness(harness);
  }
}

runCase().catch((error) => {
  console.error(error);
  process.exit(1);
});
