import * as assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { TEST_MANIFEST } from '../test-manifest.js';

interface PackageJson {
  files?: string[];
  scripts?: Record<string, string>;
  internalPublish?: {
    requiredPackPaths?: string[];
    forbiddenPackPaths?: string[];
  };
}

function readPackageJson(): PackageJson {
  return JSON.parse(fs.readFileSync('package.json', 'utf-8')) as PackageJson;
}

function manifestHasFile(file: string): boolean {
  return TEST_MANIFEST.some((entry) => entry.files.includes(file));
}

function listBundledAgentProfilePaths(): string[] {
  const agentsDir = path.resolve('agents');
  return fs
    .readdirSync(agentsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join('agents', entry.name, 'AGENTS.md').replace(/\\/g, '/'))
    .filter((profilePath) => fs.existsSync(profilePath))
    .sort((a, b) => a.localeCompare(b));
}

function readNpmPackDryRunPaths(): string[] {
  const output = execSync('npm pack --dry-run --json', {
    cwd: process.cwd(),
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const pack = JSON.parse(output) as Array<{ files?: Array<{ path?: string }> }>;
  return (pack[0]?.files ?? [])
    .map((file) => String(file.path ?? '').replace(/\\/g, '/'))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
}

function testNpmFilesWhitelistIncludesBundledAgents(): void {
  const pkg = readPackageJson();
  const files = pkg.files ?? [];
  const requiredPackPaths = pkg.internalPublish?.requiredPackPaths ?? [];
  const bundledAgentProfiles = listBundledAgentProfilePaths();

  assert.ok(files.includes('dist/**'));
  assert.ok(files.includes('scripts/asr/*.py'));
  assert.ok(files.includes('scripts/asr/*.ps1'));
  assert.ok(files.includes('agents/**'));
  assert.ok(files.includes('doc/guide/user-guide.md'));
  for (const profilePath of bundledAgentProfiles) {
    assert.ok(requiredPackPaths.includes(profilePath), `${profilePath} must be required in publish pack audit`);
  }
  assert.ok(pkg.internalPublish?.forbiddenPackPaths?.includes('runtime/'));
}

function testNpmPackDryRunContainsBundledAgents(): void {
  const packedPaths = readNpmPackDryRunPaths();
  const packedPathSet = new Set(packedPaths);
  for (const profilePath of listBundledAgentProfilePaths()) {
    assert.ok(packedPathSet.has(profilePath), `${profilePath} must be included in npm pack`);
  }
}

function testReleaseAndPublishScriptsCoverMaintainedGates(): void {
  const pkg = readPackageJson();
  const scripts = pkg.scripts ?? {};
  assert.match(scripts['release:source-gate'] ?? '', /npm test/);
  assert.match(scripts['release:source-gate'] ?? '', /build:web/);
  assert.match(scripts['release:source-gate'] ?? '', /smoke:ui:built/);
  assert.match(scripts['release:source-gate'] ?? '', /test:release-e2e/);
  assert.match(scripts['release:source-gate'] ?? '', /test:release-toolcall-context-session/);
  assert.match(scripts['publish:standard'] ?? '', /private-npm-standard\.js --mode publish/);
  assert.match(scripts['setup:asr:windows'] ?? '', /setup-glm-asr\.ps1/);
}

function testSourceContractSmokeCoverageIsInManifest(): void {
  const required = [
    'tests/unit/hook-registry.test.ts',
    'tests/unit/agent-hook-modified.test.ts',
    'tests/unit/web-asr-routes.test.ts',
    'tests/unit/web-asr-stream.test.ts',
    'tests/unit/web-observe-only-routes.test.ts',
    'tests/unit/web-wss-control.test.ts',
    'tests/unit/web-cancel-message.test.ts',
    'tests/unit/automation-store.test.ts',
    'tests/unit/web-automation-scheduler.test.ts',
    'tests/unit/web-automation-execution.test.ts',
    'tests/unit/subagent-manager.test.ts',
    'tests/unit/subagent-manage-tool.test.ts',
    'tests/unit/release-source-contract-smoke.test.ts',
  ];
  for (const file of required) {
    assert.equal(manifestHasFile(file), true, `${file} must be in TEST_MANIFEST`);
  }
}

function runAll(): void {
  testNpmFilesWhitelistIncludesBundledAgents();
  testNpmPackDryRunContainsBundledAgents();
  testReleaseAndPublishScriptsCoverMaintainedGates();
  testSourceContractSmokeCoverageIsInManifest();
  console.log('release source contract smoke tests passed');
}

runAll();
