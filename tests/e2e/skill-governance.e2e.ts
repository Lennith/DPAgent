import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { chromium } from 'playwright';
import { createWebServer } from '../../src/web/server/WebServer.js';
import { parseSkillMarkdown, renderSkillMarkdown } from '../../src/skills/skill-markdown.js';

interface ApiConfigSeed {
  apiKey: string;
  apiBase: string;
  model: string;
  provider: 'anthropic' | 'openai';
  maxOutputTokens: number;
}

function readYamlFile(filePath: string): Record<string, any> {
  return (yaml.load(fs.readFileSync(filePath, 'utf-8')) as Record<string, any> | undefined) ?? {};
}

function resolveApiSeed(repoRoot: string): ApiConfigSeed {
  const rootConfigPath = path.join(repoRoot, 'config.yaml');
  const rootConfig = fs.existsSync(rootConfigPath) ? readYamlFile(rootConfigPath) : {};
  const apiConfig = (rootConfig.api as Record<string, any> | undefined) ?? {};

  const apiKey = String(process.env.MINIMAX_API_KEY || apiConfig.apiKey || '').trim();
  if (!apiKey) {
    throw new Error('Real LLM E2E requires MINIMAX_API_KEY or a valid api.apiKey in config.yaml.');
  }

  return {
    apiKey,
    apiBase: String(process.env.MINIMAX_API_BASE || apiConfig.apiBase || 'https://api.minimax.io').trim(),
    model: String(process.env.MINIMAX_MODEL || apiConfig.model || 'MiniMax-M2.5').trim(),
    provider: (String(apiConfig.provider || 'anthropic').trim() as 'anthropic' | 'openai') || 'anthropic',
    maxOutputTokens: Number.parseInt(String(apiConfig.maxOutputTokens || 32768), 10) || 32768,
  };
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

function writeSkillFixture(input: {
  workspaceDir: string;
  slug: string;
  name: string;
  sourceFingerprint: string;
  body: string;
}): string {
  const targetPath = path.join(input.workspaceDir, 'skills', input.slug, 'SKILL.md');
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(
    targetPath,
    renderSkillMarkdown({
      name: input.name,
      description: `Auto-generated workflow ${input.name}`,
      metadata: {
        reviewStatus: 'approved',
        version: '1',
        source: 'workspace',
        generatedBy: 'auto-observe-turn',
        generationReason: 'repeated_success_pattern',
        sourceFingerprint: input.sourceFingerprint,
        sourceSessionId: `sess-${input.slug}`,
        originToolset: 'full-access',
        originPlatform: 'win32',
        generatedAt: '2026-04-20T00:00:00.000Z',
        toolsets: ['full-access'],
        platforms: ['windows'],
      },
      body: input.body,
    }),
    'utf-8'
  );
  return targetPath;
}

async function stopServerWithTimeout(server: { stop: () => Promise<void> }, timeoutMs: number): Promise<void> {
  await Promise.race([
    server.stop().catch(() => undefined),
    new Promise<void>((resolve) => {
      setTimeout(resolve, timeoutMs);
    }),
  ]);
}

async function main(): Promise<void> {
  const repoRoot = process.cwd();
  const apiSeed = resolveApiSeed(repoRoot);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-governance-e2e-'));
  const workspaceDir = path.join(tempDir, 'workspace');
  const runtimeDataDir = path.join(tempDir, 'runtime');
  const contextDir = path.join(tempDir, 'contexts');
  const configPath = path.join(tempDir, 'config.yaml');
  const logsDir = path.join(repoRoot, 'logs');
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(runtimeDataDir, { recursive: true });
  fs.mkdirSync(contextDir, { recursive: true });
  fs.mkdirSync(logsDir, { recursive: true });

  const duplicateBody = [
    'When the user asks for the release workflow, follow these exact steps.',
    '',
    '## Workflow',
    '1. `npm run build:web`',
    '2. `npm test`',
    '3. `npm run publish:standard:preflight`',
    '',
    '## Notes',
    '- Publish only after all checks succeed',
  ].join('\n');
  const controlBody = [
    'When the user asks for the Docker cleanup workflow, follow these steps.',
    '',
    '## Workflow',
    '1. `docker ps -a`',
    '2. `docker rm $(docker ps -aq)`',
    '3. `docker image prune -f`',
    '',
    '## Notes',
    '- Only run in the local cleanup workspace',
  ].join('\n');

  const canonicalPath = writeSkillFixture({
    workspaceDir,
    slug: 'workflow-release-main',
    name: 'workflow-release-main',
    sourceFingerprint: 'release-main',
    body: duplicateBody,
  });
  const duplicatePath = writeSkillFixture({
    workspaceDir,
    slug: 'workflow-release-copy',
    name: 'workflow-release-copy',
    sourceFingerprint: 'release-copy',
    body: duplicateBody,
  });
  const controlPath = writeSkillFixture({
    workspaceDir,
    slug: 'workflow-docker-cleanup',
    name: 'workflow-docker-cleanup',
    sourceFingerprint: 'docker-cleanup',
    body: controlBody,
  });

  fs.writeFileSync(
    configPath,
    yaml.dump({
      api: apiSeed,
      agent: {
        workspaceDir,
        runtimeDataDir,
        contextDir,
        defaultToolset: 'full-access',
      },
      mcp: {
        enabled: false,
        servers: [],
      },
    }),
    'utf-8'
  );

  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = createWebServer({
    port,
    configPath,
  });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await server.start();

    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    const jobsResponse = await fetch(`${baseUrl}/api/automations`);
    assert.equal(jobsResponse.ok, true);
    const jobsPayload = (await jobsResponse.json()) as {
      items?: Array<{ id: string; name: string; systemTask?: string; readOnly?: boolean }>;
    };
    const governanceJob = jobsPayload.items?.find(
      (item) => item.systemTask === 'auto_generated_skill_governance'
    );
    assert.equal(governanceJob, undefined);

    const stateResponse = await fetch(`${baseUrl}/api/governance/workspace`);
    assert.equal(stateResponse.ok, true);
    const statePayload = (await stateResponse.json()) as {
      skillItems?: Array<{ name: string; isAutoGenerated: boolean }>;
    };
    assert.equal(statePayload.skillItems?.length, 3);
    assert.equal(statePayload.skillItems?.every((item) => item.isAutoGenerated), true);

    const reportResponse = await fetch(`${baseUrl}/api/governance/skills/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(reportResponse.ok, true);
    const reportPayload = (await reportResponse.json()) as {
      report?: {
        kind: string;
        summary: {
          scannedSkills: number;
          autoArchived: number;
        };
        items: Array<{
          id: string;
          action: string;
          canonicalTargetPath?: string;
        }>;
      };
    };
    assert.ok(reportPayload.report);
    assert.equal(reportPayload.report?.kind, 'workspace_skill_governance');
    assert.equal(reportPayload.report?.summary.scannedSkills, 3);
    assert.equal((reportPayload.report?.summary.autoArchived ?? 0) >= 1, true);

    const archivedItem = reportPayload.report?.items.find((item) => item.action === 'soft_archive');
    assert.ok(archivedItem?.canonicalTargetPath);

    const archivedPath = path.resolve(String(archivedItem?.id));
    const canonicalTargetPath = path.resolve(String(archivedItem?.canonicalTargetPath));
    const archivedSkill = parseSkillMarkdown(fs.readFileSync(archivedPath, 'utf-8'));
    const canonicalSkill = parseSkillMarkdown(fs.readFileSync(canonicalTargetPath, 'utf-8'));
    const controlSkill = parseSkillMarkdown(fs.readFileSync(controlPath, 'utf-8'));
    assert.equal(archivedSkill.metadata.reviewStatus, 'deprecated');
    assert.equal(canonicalSkill.metadata.reviewStatus, 'approved');
    assert.equal(controlSkill.metadata.reviewStatus, 'approved');

    const skillsResponse = await fetch(`${baseUrl}/api/skills`);
    assert.equal(skillsResponse.ok, true);
    const skillsPayload = (await skillsResponse.json()) as {
      skills?: Array<{ name: string }>;
    };
    const visibleNames = new Set((skillsPayload.skills ?? []).map((item) => item.name));
    assert.equal(visibleNames.has(String(archivedSkill.name ?? path.basename(path.dirname(archivedPath)))), false);
    assert.equal(visibleNames.has(String(canonicalSkill.name ?? path.basename(path.dirname(canonicalTargetPath)))), true);
    assert.equal(visibleNames.has(String(controlSkill.name ?? path.basename(path.dirname(controlPath)))), true);

    const registryPath = path.join(runtimeDataDir, 'skill-packs', 'registry.json');
    assert.equal(fs.existsSync(registryPath), true);
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf-8')) as {
      packs?: Record<
        string,
        {
          name: string;
          activeVersion?: string;
          versions: Array<{ version: string; sourceSkillNames: string[] }>;
        }
      >;
    };
    const pack = Object.values(registry.packs ?? {}).find((item) => item.name === 'workspace-generated');
    assert.ok(pack?.activeVersion);
    const activeVersion = pack?.versions.find((item) => item.version === pack.activeVersion);
    assert.ok(activeVersion);
    const archivedName = String(archivedSkill.name ?? path.basename(path.dirname(archivedPath)));
    assert.equal(activeVersion?.sourceSkillNames.includes(archivedName), false);

    const screenshotPath = path.join(logsDir, 'skill-governance-e2e.png');
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`[skill-governance-e2e] PASS: ${baseUrl}`);
    console.log(`[skill-governance-e2e] screenshot: ${screenshotPath}`);
  } finally {
    await browser.close();
    await stopServerWithTimeout(server, 5000);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error(`[skill-governance-e2e] FAIL: ${error instanceof Error ? error.stack || error.message : String(error)}`);
    process.exit(1);
  });
