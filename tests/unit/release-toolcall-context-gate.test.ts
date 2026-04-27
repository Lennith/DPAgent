import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  RELEASE_TOOLCALL_AGGREGATE_FILE,
  RELEASE_TOOLCALL_MANUAL_REVIEW_FILE,
  RELEASE_TOOLCALL_MARKDOWN_FILE,
  parseArgs,
  resolveRuntimeProfiles,
  type GateArgs,
  type SessionReport,
  writeGateArtifacts,
} from '../../scripts/release-toolcall-context-gate.ts';

function createArgs(outputRoot: string): GateArgs {
  return {
    runs: 3,
    rounds: 20,
    minPassRate: 0.9,
    model: 'multi-profile',
    profiles: ['kimi', 'deepseek', 'minimax'],
    configPath: path.join(outputRoot, 'config.yaml'),
    devProfilesPath: path.join(outputRoot, 'release-toolcall-profiles.dev.json'),
    localProfilesPath: path.join(outputRoot, 'release-toolcall-profiles.local.json'),
    runTimeoutMs: 1800000,
    outputRoot,
  };
}

function createProfiles() {
  return [
    {
      label: 'kimi',
      id: 'kimi-profile',
      name: 'Kimi',
      provider: 'anthropic' as const,
      apiKey: 'test-key',
      apiBase: 'https://api.kimi.test/anthropic',
      model: 'kimi-for-coding',
    },
    {
      label: 'deepseek',
      id: 'deepseek-profile',
      name: 'DeepSeek',
      provider: 'anthropic' as const,
      apiKey: 'test-key',
      apiBase: 'https://api.deepseek.test/anthropic',
      model: 'deepseek-v4-flash',
    },
    {
      label: 'minimax',
      id: 'minimax-profile',
      name: 'MiniMax',
      provider: 'anthropic' as const,
      apiKey: 'test-key',
      apiBase: 'https://api.minimax.test/anthropic',
      model: 'MiniMax-M2.7-highspeed',
    },
  ];
}

function createSessionReport(
  sessionId: string,
  accuracy: number,
  failureFlagCounts: Record<string, number> = {}
): SessionReport {
  const passCount = Math.round(accuracy * 20);
  return {
    sessionId,
    provider: 'anthropic',
    model: 'profile-model',
    passCount,
    failCount: 20 - passCount,
    accuracy,
    failureFlagCounts,
    rounds: Array.from({ length: 20 }, (_value, index) => ({
      round: index + 1,
      flags: failureFlagCounts.tools_missing ? ['tools_missing'] : [],
      ok: index < passCount,
    })),
  };
}

function writeJson(rootDir: string, relativePath: string, payload: unknown): string {
  const fullPath = path.join(rootDir, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, JSON.stringify(payload, null, 2), 'utf8');
  return fullPath;
}

function testWriteGateArtifactsProducesManualReviewTemplate(): void {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'release-toolcall-gate-'));
  try {
    const args = createArgs(outputRoot);
    const runs = [
      createSessionReport('sess-run-01', 1),
      createSessionReport('sess-run-02', 0.9, { tools_missing: 1 }),
      createSessionReport('sess-run-03', 1),
    ];
    const profiles = createProfiles();
    const generatedAt = '2026-04-24T06:00:00.000Z';
    const sourceCommitSha = 'abc123def456';
    const { aggregate, manualReview } = writeGateArtifacts(args, runs, profiles, generatedAt, sourceCommitSha);

    const aggregatePath = path.join(outputRoot, RELEASE_TOOLCALL_AGGREGATE_FILE);
    const reviewPath = path.join(outputRoot, RELEASE_TOOLCALL_MANUAL_REVIEW_FILE);
    const markdownPath = path.join(outputRoot, RELEASE_TOOLCALL_MARKDOWN_FILE);

    assert.equal(fs.existsSync(aggregatePath), true);
    assert.equal(fs.existsSync(reviewPath), true);
    assert.equal(fs.existsSync(markdownPath), true);

    const persistedAggregate = JSON.parse(
      fs.readFileSync(aggregatePath, 'utf8')
    ) as typeof aggregate;
    const persistedReview = JSON.parse(
      fs.readFileSync(reviewPath, 'utf8')
    ) as typeof manualReview;

    assert.equal(persistedAggregate.generatedAt, generatedAt);
    assert.equal(persistedAggregate.sourceCommitSha, sourceCommitSha);
    assert.equal(persistedAggregate.gatePassed, true);
    assert.equal(persistedAggregate.manualReviewRequired, true);
    assert.deepEqual(
      persistedAggregate.manualReview.reviewedRunSessionIds,
      ['sess-run-01', 'sess-run-02', 'sess-run-03']
    );
    assert.deepEqual(persistedAggregate.requiredProfiles, ['kimi', 'deepseek', 'minimax']);
    assert.equal(persistedAggregate.model, 'multi-profile');
    assert.equal(
      persistedAggregate.manualReview.templateFile,
      RELEASE_TOOLCALL_MANUAL_REVIEW_FILE
    );
    assert.equal(persistedReview.generatedAt, generatedAt);
    assert.equal(persistedReview.aggregateGeneratedAt, generatedAt);
    assert.equal(persistedReview.reviewedCommitSha, sourceCommitSha);
    assert.deepEqual(persistedReview.reviewedRunSessionIds, ['sess-run-01', 'sess-run-02', 'sess-run-03']);
    assert.equal(persistedReview.reviewedRequiredRuns, 3);
    assert.equal(persistedReview.reviewedRoundsPerRun, 20);
    assert.equal(persistedReview.reviewedModel, 'multi-profile');
    assert.deepEqual(persistedReview.reviewedProfiles, ['kimi', 'deepseek', 'minimax']);
    assert.equal(persistedReview.conclusion, 'pending');
    assert.equal(persistedReview.checklist.runMetricsChecked, false);
    assert.equal(persistedReview.checklist.materiallyCorrect, false);
    assert.equal(persistedReview.checklist.seriousHallucinationFound, false);
    assert.equal(persistedReview.checklist.scriptFalsePositivePassFound, false);
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true });
  }
}

function testDefaultRunTimeoutIsFifteenMinutes(): void {
  const args = parseArgs([]);
  assert.equal(args.runTimeoutMs, 900000);
}

function testRunTimeoutCanBeSetExplicitly(): void {
  const args = parseArgs(['--run-timeout-ms', '120000']);
  assert.equal(args.runTimeoutMs, 120000);
}

function testDevProfilesCanOmitKimiModelAndLocalProfilesOverride(): void {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'release-toolcall-gate-profiles-'));
  try {
    const args = createArgs(outputRoot);
    fs.writeFileSync(
      args.configPath,
      [
        'api:',
        '  model: MiniMax-M2.7-highspeed',
        '  apiBase: https://api.minimaxi.com',
        '  provider: anthropic',
      ].join('\n'),
      'utf8'
    );
    writeJson(outputRoot, 'release-toolcall-profiles.dev.json', {
      profiles: [
        {
          id: 'kimi-dev',
          label: 'kimi',
          name: 'Kimi',
          provider: 'anthropic',
          apiKey: 'test-key',
          apiBase: 'https://api.minimaxi.com',
        },
        {
          id: 'deepseek-dev',
          label: 'deepseek',
          name: 'DeepSeek',
          provider: 'anthropic',
          apiKey: 'test-key',
          apiBase: 'https://api.minimaxi.com',
          model: 'wrong-model',
        },
        {
          id: 'minimax-dev',
          label: 'minimax',
          name: 'MiniMax',
          provider: 'anthropic',
          apiKey: 'test-key',
          apiBase: 'https://api.minimaxi.com',
          model: 'MiniMax-M2.7-highspeed',
        },
      ],
    });
    writeJson(outputRoot, 'release-toolcall-profiles.local.json', {
      profiles: [
        {
          id: 'deepseek-local',
          label: 'deepseek',
          name: 'DeepSeek',
          provider: 'anthropic',
          apiKey: 'local-key',
          apiBase: 'https://api.minimaxi.com',
          model: 'deepseek-v4-flash',
        },
      ],
    });

    const profiles = resolveRuntimeProfiles(args);
    assert.equal(profiles[0].label, 'kimi');
    assert.equal(profiles[0].model, 'Kimi-k2.6');
    assert.equal(profiles[1].id, 'deepseek-local');
    assert.equal(profiles[1].model, 'deepseek-v4-flash');
    assert.equal(profiles[2].model, 'MiniMax-M2.7-highspeed');
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true });
  }
}

function testDeepSeekModelContractRejectsStaleOverride(): void {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'release-toolcall-gate-bad-deepseek-'));
  try {
    const args = createArgs(outputRoot);
    fs.writeFileSync(args.configPath, 'api:\n  model: MiniMax-M2.7-highspeed\n', 'utf8');
    writeJson(outputRoot, 'release-toolcall-profiles.dev.json', {
      profiles: [
        {
          id: 'kimi-dev',
          label: 'kimi',
          name: 'Kimi',
          provider: 'anthropic',
          apiKey: 'test-key',
          apiBase: 'https://api.minimaxi.com',
        },
        {
          id: 'deepseek-dev',
          label: 'deepseek',
          name: 'DeepSeek',
          provider: 'anthropic',
          apiKey: 'test-key',
          apiBase: 'https://api.minimaxi.com',
          model: 'deepseek-v4-flash',
        },
        {
          id: 'minimax-dev',
          label: 'minimax',
          name: 'MiniMax',
          provider: 'anthropic',
          apiKey: 'test-key',
          apiBase: 'https://api.minimaxi.com',
          model: 'MiniMax-M2.7-highspeed',
        },
      ],
    });
    writeJson(outputRoot, 'release-toolcall-profiles.local.json', {
      profiles: [
        {
          id: 'deepseek-local',
          label: 'deepseek',
          name: 'DeepSeek',
          provider: 'anthropic',
          apiKey: 'local-key',
          apiBase: 'https://api.minimaxi.com',
          model: 'MiniMax-M2.7-highspeed',
        },
      ],
    });

    assert.throws(
      () => resolveRuntimeProfiles(args),
      /deepseek.*must use model deepseek-v4-flash/i
    );
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true });
  }
}

function runAll(): void {
  testWriteGateArtifactsProducesManualReviewTemplate();
  testDefaultRunTimeoutIsFifteenMinutes();
  testRunTimeoutCanBeSetExplicitly();
  testDevProfilesCanOmitKimiModelAndLocalProfilesOverride();
  testDeepSeekModelContractRejectsStaleOverride();
  console.log('release-toolcall-context-gate tests passed');
}

runAll();
