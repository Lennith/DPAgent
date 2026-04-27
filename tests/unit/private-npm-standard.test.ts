import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  createPublishPlan,
  fetchResponseOrFail,
  getInternalPublishConfig,
  resolveSmokeRuntimeConfigFromSources,
  validatePackFileList,
  validateCleanGitWorktree,
  validateReleaseToolcallGateEvidence,
} = require('../../scripts/private-npm-standard.js') as {
  createPublishPlan: (mode: 'preflight' | 'publish') => {
    verifyReleaseEvidence: boolean;
    buildBeforePublish: boolean;
    dryRunPack: boolean;
    packagedSmoke: boolean;
    registrySmoke: boolean;
    publish: boolean;
  };
  fetchResponseOrFail: (url: string, options?: { timeoutMs?: number; retryDelayMs?: number }) => Promise<Response>;
  getInternalPublishConfig: (pkg: Record<string, unknown>) => {
    registry: string;
    userSmoke: null | {
      command: string;
      timeoutMs: number;
      successPattern: string;
    };
  };
  resolveSmokeRuntimeConfigFromSources: (sources: {
    env?: Record<string, string | undefined>;
    dotenvKey?: string;
    configApi?: Record<string, unknown>;
  }) => {
    apiKey: string;
    apiBase: string;
    model: string;
    provider: string;
    maxOutputTokens: string;
  };
  validateCleanGitWorktree: (
    cwd: string,
    options?: { statusOutput?: string }
  ) => string[];
  validateReleaseToolcallGateEvidence: (
    rootDir: string,
    cfg: {
      outputRoot: string;
      aggregateFile: string;
      markdownFile: string;
      manualReviewFile: string;
      requiredRuns: number;
      requiredRoundsPerRun: number;
      requiredModel: string;
      requiredProfiles?: string[];
      requiredProfileModels?: Record<string, string>;
      minimumPassRate: number;
    },
    options?: { currentCommitSha?: string }
  ) => {
    aggregatePath: string;
    markdownPath: string;
    manualReviewPath: string;
    currentCommitSha: string;
  };
  validatePackFileList: (
    packResult: { files?: Array<{ path?: string }> },
    cfg: {
      forbiddenPackPaths: string[];
      requiredPackPaths: string[];
    },
    label?: string
  ) => unknown;
};

const CURRENT_COMMIT_SHA = 'abc123def456';

function createConfig() {
  return {
    outputRoot: 'logs/release-gate-toolcall-context-session',
    aggregateFile: 'release-toolcall-context-gate.json',
    markdownFile: 'release-toolcall-context-gate.md',
    manualReviewFile: 'release-toolcall-context-manual-review.json',
    requiredRuns: 3,
    requiredRoundsPerRun: 20,
    requiredModel: 'multi-profile',
    requiredProfiles: ['kimi', 'deepseek', 'minimax'],
    requiredProfileModels: {
      kimi: 'Kimi-k2.6',
      deepseek: 'deepseek-v4-flash',
      minimax: 'MiniMax-M2.7-highspeed',
    },
    minimumPassRate: 0.9,
  };
}

function writeJson(rootDir: string, relativePath: string, payload: unknown): string {
  const fullPath = path.join(rootDir, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, JSON.stringify(payload, null, 2), 'utf8');
  return fullPath;
}

function writeText(rootDir: string, relativePath: string, content: string): string {
  const fullPath = path.join(rootDir, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf8');
  return fullPath;
}

function createAggregate(overrides: Record<string, unknown> = {}) {
  return {
    generatedAt: '2026-04-24T08:00:00.000Z',
    sourceCommitSha: CURRENT_COMMIT_SHA,
    runs: [
      {
        index: 1,
        profile: 'kimi',
        profileId: 'kimi-profile',
        profileName: 'Kimi',
        sessionId: 'sess-run-01',
        provider: 'anthropic',
        model: 'Kimi-k2.6',
        passCount: 20,
        failCount: 0,
        accuracy: 1,
        failureFlagCounts: {},
        thresholdPassed: true,
      },
      {
        index: 2,
        profile: 'deepseek',
        profileId: 'deepseek-profile',
        profileName: 'DeepSeek',
        sessionId: 'sess-run-02',
        provider: 'anthropic',
        model: 'deepseek-v4-flash',
        passCount: 18,
        failCount: 2,
        accuracy: 0.9,
        failureFlagCounts: {
          tools_missing: 1,
        },
        thresholdPassed: true,
      },
      {
        index: 3,
        profile: 'minimax',
        profileId: 'minimax-profile',
        profileName: 'MiniMax',
        sessionId: 'sess-run-03',
        provider: 'anthropic',
        model: 'MiniMax-M2.7-highspeed',
        passCount: 20,
        failCount: 0,
        accuracy: 1,
        failureFlagCounts: {},
        thresholdPassed: true,
      },
    ],
    requiredRuns: 3,
    roundsPerRun: 20,
    minPassRate: 0.9,
    model: 'multi-profile',
    requiredProfiles: ['kimi', 'deepseek', 'minimax'],
    gatePassed: true,
    manualReviewRequired: true,
    manualReview: {
      required: true,
      aggregateFile: 'release-toolcall-context-gate.json',
      templateFile: 'release-toolcall-context-manual-review.json',
      generatedAt: '2026-04-24T08:00:00.000Z',
      reviewedRunSessionIds: ['sess-run-01', 'sess-run-02', 'sess-run-03'],
    },
    ...overrides,
  };
}

function createReview(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    generatedAt: '2026-04-24T08:05:00.000Z',
    aggregateGeneratedAt: '2026-04-24T08:00:00.000Z',
    reviewedCommitSha: CURRENT_COMMIT_SHA,
    reviewer: 'reviewer@example.com',
    reviewedAt: '2026-04-24T08:10:00.000Z',
    reviewedRunSessionIds: ['sess-run-01', 'sess-run-02', 'sess-run-03'],
    reviewedRequiredRuns: 3,
    reviewedRoundsPerRun: 20,
    reviewedModel: 'multi-profile',
    reviewedProfiles: ['kimi', 'deepseek', 'minimax'],
    checklist: {
      runMetricsChecked: true,
      failureFlagsChecked: true,
      fieldMismatchesChecked: true,
      toolCallContinuityChecked: true,
      cascadeFailuresChecked: true,
      completionMarkerRepairsChecked: true,
      materiallyCorrect: true,
      seriousHallucinationFound: false,
      scriptFalsePositivePassFound: false,
    },
    conclusion: 'approved',
    issuesFound: [],
    notes: 'Reviewed both runs and approved.',
    ...overrides,
  };
}

function assertThrowsMessage(fn: () => void, pattern: RegExp): void {
  let thrown: unknown = null;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  assert.notEqual(thrown, null);
  assert.match(String((thrown as Error).message), pattern);
}

function testFailsWhenGitWorktreeIsDirty(): void {
  assertThrowsMessage(
    () =>
      validateCleanGitWorktree('D:/fake-repo', {
        statusOutput: ' M src/index.ts\n?? tests/unit/private-npm-standard.test.ts\n',
      }),
    /git worktree is dirty/i
  );
}

function testPassesWhenGitWorktreeIsClean(): void {
  const dirtyEntries = validateCleanGitWorktree('D:/fake-repo', {
    statusOutput: '\n',
  });
  assert.deepEqual(dirtyEntries, []);
}

function testPublishPlanRebuildsBeforePublishingButSkipsSourceGateRetest(): void {
  const plan = createPublishPlan('publish');
  assert.equal(plan.verifyReleaseEvidence, true);
  assert.equal(plan.buildBeforePublish, true);
  assert.equal(plan.dryRunPack, false);
  assert.equal(plan.packagedSmoke, false);
  assert.equal(plan.registrySmoke, true);
  assert.equal(plan.publish, true);
}

function testPackAuditUsesSingleRealPackResult(): void {
  const result = validatePackFileList(
    {
      files: [{ path: 'dist/index.js' }, { path: 'README.md' }],
    },
    {
      forbiddenPackPaths: ['logs/', '.env'],
      requiredPackPaths: ['dist/', 'README.md'],
    },
    'publish'
  );
  assert.equal(result && typeof result === 'object', true);
}

function testPackAuditBlocksForbiddenFiles(): void {
  assertThrowsMessage(
    () =>
      validatePackFileList(
        {
          files: [{ path: 'dist/index.js' }, { path: 'README.md' }, { path: 'logs/secret.txt' }],
        },
        {
          forbiddenPackPaths: ['logs/', '.env'],
          requiredPackPaths: ['dist/', 'README.md'],
        },
        'publish'
      ),
    /forbidden runtime\/sensitive files/i
  );
}

function testPublishConfigParsesUserSmoke(): void {
  const cfg = getInternalPublishConfig({
    internalPublish: {
      registry: 'http://registry.test',
      requiredReadmeInitCommand: 'npx minimax-agent',
      userSmoke: {
        command: 'npx minimax-agent --no-open',
        timeoutMs: 120000,
        successPattern: 'Starting web server at http://localhost:{PORT}',
      },
      requiredPackPaths: ['dist/', 'README.md'],
      forbiddenPackPaths: ['logs/', '.env'],
      releaseToolcallGate: createConfig(),
    },
  });
  assert.deepEqual(cfg.userSmoke, {
    command: 'npx minimax-agent --no-open',
    timeoutMs: 120000,
    successPattern: 'Starting web server at http://localhost:{PORT}',
  });
}

function testFailsWhenManualReviewArtifactIsMissing(): void {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'private-npm-standard-missing-'));
  try {
    const cfg = createConfig();
    writeJson(rootDir, path.join(cfg.outputRoot, cfg.aggregateFile), createAggregate());
    writeText(rootDir, path.join(cfg.outputRoot, cfg.markdownFile), '# aggregate');
    assertThrowsMessage(
      () => validateReleaseToolcallGateEvidence(rootDir, cfg, { currentCommitSha: CURRENT_COMMIT_SHA }),
      /manual review is missing/i
    );
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

function testFailsWhenManualReviewArtifactIsIncomplete(): void {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'private-npm-standard-incomplete-'));
  try {
    const cfg = createConfig();
    writeJson(rootDir, path.join(cfg.outputRoot, cfg.aggregateFile), createAggregate());
    writeText(rootDir, path.join(cfg.outputRoot, cfg.markdownFile), '# aggregate');
    writeJson(
      rootDir,
      path.join(cfg.outputRoot, cfg.manualReviewFile),
      createReview({ reviewer: '', checklist: { runMetricsChecked: false } })
    );
    assertThrowsMessage(
      () => validateReleaseToolcallGateEvidence(rootDir, cfg, { currentCommitSha: CURRENT_COMMIT_SHA }),
      /missing reviewer|checklist\.runMetricsChecked must be true/i
    );
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

function testFailsWhenManualReviewArtifactIsStale(): void {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'private-npm-standard-stale-'));
  try {
    const cfg = createConfig();
    writeJson(rootDir, path.join(cfg.outputRoot, cfg.aggregateFile), createAggregate());
    writeText(rootDir, path.join(cfg.outputRoot, cfg.markdownFile), '# aggregate');
    writeJson(
      rootDir,
      path.join(cfg.outputRoot, cfg.manualReviewFile),
      createReview({
        aggregateGeneratedAt: '2026-04-24T07:59:59.000Z',
        reviewedRunSessionIds: ['sess-run-01', 'sess-run-99'],
      })
    );
    assertThrowsMessage(
      () => validateReleaseToolcallGateEvidence(rootDir, cfg, { currentCommitSha: CURRENT_COMMIT_SHA }),
      /stale|reviewedRunSessionIds mismatch/i
    );
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

function testFailsWhenManualReviewRejectsRelease(): void {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'private-npm-standard-rejected-'));
  try {
    const cfg = createConfig();
    writeJson(rootDir, path.join(cfg.outputRoot, cfg.aggregateFile), createAggregate());
    writeText(rootDir, path.join(cfg.outputRoot, cfg.markdownFile), '# aggregate');
    writeJson(
      rootDir,
      path.join(cfg.outputRoot, cfg.manualReviewFile),
      createReview({
        conclusion: 'rejected',
        checklist: {
          runMetricsChecked: true,
          failureFlagsChecked: true,
          fieldMismatchesChecked: true,
          toolCallContinuityChecked: true,
          cascadeFailuresChecked: true,
          completionMarkerRepairsChecked: true,
          materiallyCorrect: true,
          seriousHallucinationFound: true,
          scriptFalsePositivePassFound: false,
        },
      })
    );
    assertThrowsMessage(
      () => validateReleaseToolcallGateEvidence(rootDir, cfg, { currentCommitSha: CURRENT_COMMIT_SHA }),
      /seriousHallucinationFound must be false|conclusion must be approved/i
    );
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

function testFailsWhenAggregateContractDoesNotMatchMaintainedGate(): void {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'private-npm-standard-contract-'));
  try {
    const cfg = createConfig();
    writeJson(
      rootDir,
      path.join(cfg.outputRoot, cfg.aggregateFile),
      createAggregate({
        requiredRuns: 1,
        roundsPerRun: 20,
        model: 'MiniMax-M2.7',
        minPassRate: 0.8,
      })
    );
    writeText(rootDir, path.join(cfg.outputRoot, cfg.markdownFile), '# aggregate');
    writeJson(rootDir, path.join(cfg.outputRoot, cfg.manualReviewFile), createReview());
    assertThrowsMessage(
      () => validateReleaseToolcallGateEvidence(rootDir, cfg, { currentCommitSha: CURRENT_COMMIT_SHA }),
      /requiredRuns mismatch|roundsPerRun mismatch|model mismatch|minPassRate mismatch/i
    );
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

function testFailsWhenProfileModelEvidenceDoesNotMatchMaintainedGate(): void {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'private-npm-standard-profile-model-'));
  try {
    const cfg = createConfig();
    const aggregate = createAggregate({
      runs: createAggregate().runs.map((run) =>
        run.profile === 'deepseek'
          ? {
              ...run,
              model: 'wrong-model',
            }
          : run
      ),
    });
    writeJson(rootDir, path.join(cfg.outputRoot, cfg.aggregateFile), aggregate);
    writeText(rootDir, path.join(cfg.outputRoot, cfg.markdownFile), '# aggregate');
    writeJson(rootDir, path.join(cfg.outputRoot, cfg.manualReviewFile), createReview());
    assertThrowsMessage(
      () => validateReleaseToolcallGateEvidence(rootDir, cfg, { currentCommitSha: CURRENT_COMMIT_SHA }),
      /run model mismatch for profile deepseek/i
    );
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

function testFailsWhenRunProfilesDoNotMatchMaintainedGate(): void {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'private-npm-standard-run-profiles-'));
  try {
    const cfg = createConfig();
    const aggregate = createAggregate({
      runs: createAggregate().runs.map((run) =>
        run.profile === 'minimax'
          ? {
              ...run,
              profile: 'deepseek',
              profileId: 'deepseek-duplicate',
              model: 'deepseek-v4-flash',
            }
          : run
      ),
    });
    writeJson(rootDir, path.join(cfg.outputRoot, cfg.aggregateFile), aggregate);
    writeText(rootDir, path.join(cfg.outputRoot, cfg.markdownFile), '# aggregate');
    writeJson(rootDir, path.join(cfg.outputRoot, cfg.manualReviewFile), createReview());
    assertThrowsMessage(
      () => validateReleaseToolcallGateEvidence(rootDir, cfg, { currentCommitSha: CURRENT_COMMIT_SHA }),
      /run profiles mismatch/i
    );
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

function testFailsWhenMarkdownArtifactIsMissing(): void {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'private-npm-standard-markdown-'));
  try {
    const cfg = createConfig();
    writeJson(rootDir, path.join(cfg.outputRoot, cfg.aggregateFile), createAggregate());
    writeJson(rootDir, path.join(cfg.outputRoot, cfg.manualReviewFile), createReview());
    assertThrowsMessage(
      () => validateReleaseToolcallGateEvidence(rootDir, cfg, { currentCommitSha: CURRENT_COMMIT_SHA }),
      /markdown report is missing/i
    );
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

function testFailsWhenCommitBindingIsStale(): void {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'private-npm-standard-commit-'));
  try {
    const cfg = createConfig();
    writeJson(
      rootDir,
      path.join(cfg.outputRoot, cfg.aggregateFile),
      createAggregate({ sourceCommitSha: 'stale-commit' })
    );
    writeText(rootDir, path.join(cfg.outputRoot, cfg.markdownFile), '# aggregate');
    writeJson(
      rootDir,
      path.join(cfg.outputRoot, cfg.manualReviewFile),
      createReview({ reviewedCommitSha: 'stale-commit' })
    );
    assertThrowsMessage(
      () => validateReleaseToolcallGateEvidence(rootDir, cfg, { currentCommitSha: CURRENT_COMMIT_SHA }),
      /sourceCommitSha does not match current HEAD/i
    );
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

function testPassesWhenReleaseOnlyReviewReusesSourceGate(): void {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'private-npm-standard-reuse-'));
  try {
    const cfg = createConfig();
    const previousCommitSha = 'previous-source-gate-sha';
    writeJson(
      rootDir,
      path.join(cfg.outputRoot, cfg.aggregateFile),
      createAggregate({ sourceCommitSha: previousCommitSha })
    );
    writeText(rootDir, path.join(cfg.outputRoot, cfg.markdownFile), '# aggregate');
    writeJson(
      rootDir,
      path.join(cfg.outputRoot, cfg.manualReviewFile),
      createReview({
        reviewedCommitSha: CURRENT_COMMIT_SHA,
        sourceGateReuse: {
          approved: true,
          scope: 'release-process-only',
          previousReviewedCommitSha: previousCommitSha,
          currentCommitSha: CURRENT_COMMIT_SHA,
          diffScope: ['scripts/private-npm-standard.js', 'docs/private-npm-publish.md'],
          skippedCommands: ['npm run release:source-gate'],
          rationale: 'Only release workflow handling changed; runtime, UI, and LLM logic were not changed.',
        },
      })
    );
    const result = validateReleaseToolcallGateEvidence(rootDir, cfg, {
      currentCommitSha: CURRENT_COMMIT_SHA,
    });
    assert.equal(result.currentCommitSha, CURRENT_COMMIT_SHA);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

function testFailsWhenReleaseOnlyReuseEvidenceIsIncomplete(): void {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'private-npm-standard-bad-reuse-'));
  try {
    const cfg = createConfig();
    writeJson(
      rootDir,
      path.join(cfg.outputRoot, cfg.aggregateFile),
      createAggregate({ sourceCommitSha: 'previous-source-gate-sha' })
    );
    writeText(rootDir, path.join(cfg.outputRoot, cfg.markdownFile), '# aggregate');
    writeJson(
      rootDir,
      path.join(cfg.outputRoot, cfg.manualReviewFile),
      createReview({
        reviewedCommitSha: CURRENT_COMMIT_SHA,
        sourceGateReuse: {
          approved: true,
          scope: 'runtime-change',
          previousReviewedCommitSha: 'different-sha',
          currentCommitSha: CURRENT_COMMIT_SHA,
          diffScope: [],
          skippedCommands: [],
          rationale: '',
        },
      })
    );
    assertThrowsMessage(
      () => validateReleaseToolcallGateEvidence(rootDir, cfg, { currentCommitSha: CURRENT_COMMIT_SHA }),
      /sourceGateReuse.*scope must be release-process-only|sourceCommitSha does not match current HEAD/i
    );
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

function testPassesWhenManualReviewMatchesAggregate(): void {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'private-npm-standard-ok-'));
  try {
    const cfg = createConfig();
    writeJson(rootDir, path.join(cfg.outputRoot, cfg.aggregateFile), createAggregate());
    writeText(rootDir, path.join(cfg.outputRoot, cfg.markdownFile), '# aggregate');
    writeJson(rootDir, path.join(cfg.outputRoot, cfg.manualReviewFile), createReview());
    const result = validateReleaseToolcallGateEvidence(rootDir, cfg, {
      currentCommitSha: CURRENT_COMMIT_SHA,
    });
    assert.match(result.aggregatePath, /release-toolcall-context-gate\.json/i);
    assert.match(result.markdownPath, /release-toolcall-context-gate\.md/i);
    assert.match(result.manualReviewPath, /release-toolcall-context-manual-review\.json/i);
    assert.equal(result.currentCommitSha, CURRENT_COMMIT_SHA);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

function testPassesWithoutGerritChangeUrl(): void {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'private-npm-standard-no-gerrit-'));
  try {
    const cfg = createConfig();
    writeJson(rootDir, path.join(cfg.outputRoot, cfg.aggregateFile), createAggregate());
    writeText(rootDir, path.join(cfg.outputRoot, cfg.markdownFile), '# aggregate');
    writeJson(rootDir, path.join(cfg.outputRoot, cfg.manualReviewFile), createReview());
    const result = validateReleaseToolcallGateEvidence(rootDir, cfg, {
      currentCommitSha: CURRENT_COMMIT_SHA,
    });
    assert.equal(result.currentCommitSha, CURRENT_COMMIT_SHA);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

function testSmokeRuntimeConfigCarriesEndpointAndModel(): void {
  const runtime = resolveSmokeRuntimeConfigFromSources({
    env: {
      MINIMAX_API_KEY: '',
      MINIMAX_API_BASE: '',
      MINIMAX_MODEL: '',
      MINIMAX_PROVIDER: '',
    },
    dotenvKey: 'sk-dotenv',
    configApi: {
      apiKey: 'sk-config',
      apiBase: 'https://api.deepseek.com/anthropic',
      model: 'deepseek-v4-flash',
      provider: 'anthropic',
      maxOutputTokens: 4096,
    },
  });
  assert.deepEqual(runtime, {
    apiKey: 'sk-dotenv',
    apiBase: 'https://api.deepseek.com/anthropic',
    model: 'deepseek-v4-flash',
    provider: 'anthropic',
    maxOutputTokens: '4096',
  });
}

async function testSmokeFetchRetriesTransientReadinessFailures(): Promise<void> {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    if (calls < 3) {
      const error = new Error('fetch failed') as Error & { cause?: { code: string } };
      error.cause = { code: 'ECONNREFUSED' };
      throw error;
    }
    return new Response('ok', { status: 200 });
  }) as typeof fetch;
  try {
    const response = await fetchResponseOrFail('http://127.0.0.1:53721/api/health', {
      timeoutMs: 1000,
      retryDelayMs: 1,
    });
    assert.equal(response.ok, true);
    assert.equal(calls, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function runAll(): Promise<void> {
  testFailsWhenGitWorktreeIsDirty();
  testPassesWhenGitWorktreeIsClean();
  testPublishPlanRebuildsBeforePublishingButSkipsSourceGateRetest();
  testPackAuditUsesSingleRealPackResult();
  testPackAuditBlocksForbiddenFiles();
  testPublishConfigParsesUserSmoke();
  testFailsWhenManualReviewArtifactIsMissing();
  testFailsWhenManualReviewArtifactIsIncomplete();
  testFailsWhenManualReviewArtifactIsStale();
  testFailsWhenManualReviewRejectsRelease();
  testFailsWhenAggregateContractDoesNotMatchMaintainedGate();
  testFailsWhenProfileModelEvidenceDoesNotMatchMaintainedGate();
  testFailsWhenRunProfilesDoNotMatchMaintainedGate();
  testFailsWhenMarkdownArtifactIsMissing();
  testFailsWhenCommitBindingIsStale();
  testPassesWhenReleaseOnlyReviewReusesSourceGate();
  testFailsWhenReleaseOnlyReuseEvidenceIsIncomplete();
  testPassesWhenManualReviewMatchesAggregate();
  testPassesWithoutGerritChangeUrl();
  testSmokeRuntimeConfigCarriesEndpointAndModel();
  await testSmokeFetchRetriesTransientReadinessFailures();
  console.log('private-npm-standard tests passed');
}

runAll().catch((error) => {
  console.error(error);
  process.exit(1);
});
