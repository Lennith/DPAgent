import * as assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { TEST_MANIFEST } from '../test-manifest.js';

interface PackageJson {
  files?: string[];
  scripts?: Record<string, string>;
  internalPublish?: unknown;
  publishConfig?: {
    registry?: string;
    access?: string;
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

function testNpmFilesWhitelistIncludesPublicSupportFiles(): void {
  const pkg = readPackageJson();
  const files = pkg.files ?? [];

  assert.ok(files.includes('dist/**'));
  assert.ok(files.includes('scripts/asr/*.py'));
  assert.ok(files.includes('scripts/asr/*.ps1'));
  assert.ok(files.includes('agents/**'));
  assert.ok(files.includes('doc/guide/user-guide.md'));
  assert.ok(files.includes('config.example.yaml'));
  assert.ok(files.includes('CONFIG.md'));
  assert.ok(files.includes('SECURITY.md'));
  assert.ok(files.includes('CONTRIBUTING.md'));
  assert.ok(files.includes('SUPPORT.md'));
  assert.equal(pkg.internalPublish, undefined);
  assert.equal(pkg.publishConfig?.registry, 'https://registry.npmjs.org');
  assert.equal(pkg.publishConfig?.access, 'public');
}

function testNpmPackDryRunContainsBundledAgentsAndPublicDocs(): void {
  const packedPaths = readNpmPackDryRunPaths();
  const packedPathSet = new Set(packedPaths);
  for (const profilePath of listBundledAgentProfilePaths()) {
    assert.ok(packedPathSet.has(profilePath), `${profilePath} must be included in npm pack`);
  }
  assert.ok(packedPathSet.has('config.example.yaml'));
  assert.ok(packedPathSet.has('SECURITY.md'));
  assert.ok(packedPathSet.has('SUPPORT.md'));
  assert.equal(packedPathSet.has('config.yaml'), false);
}

function testReleaseAndPublishScriptsCoverMaintainedGates(): void {
  const pkg = readPackageJson();
  const scripts = pkg.scripts ?? {};
  assert.match(scripts['release:source-gate'] ?? '', /npm test/);
  assert.match(scripts['release:source-gate'] ?? '', /build:web/);
  assert.match(scripts['release:source-gate'] ?? '', /smoke:ui:built/);
  assert.match(scripts['release:source-gate'] ?? '', /test:release-e2e/);
  assert.match(scripts['release:source-gate'] ?? '', /test:release-toolcall-context-session/);
  assert.match(scripts['publish:npm-official:preflight'] ?? '', /npm-official-publish\.js --mode preflight/);
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
  testNpmFilesWhitelistIncludesPublicSupportFiles();
  testNpmPackDryRunContainsBundledAgentsAndPublicDocs();
  testReleaseAndPublishScriptsCoverMaintainedGates();
  testSourceContractSmokeCoverageIsInManifest();
  console.log('release source contract smoke tests passed');
}

runAll();
