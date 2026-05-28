import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  detectCompletionMarker,
  parseStructuredLines,
  previousRuntimeFromEvaluation,
  validateRequiredOperations,
} from '../../scripts/lib/eval-toolcall-context-core.ts';

function runDryRun(outputRoot: string): { toolsetName?: string; rounds: Array<{ round: number; prompt: string }> } {
  const result = spawnSync(
    process.execPath,
    [
      path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs'),
      path.join(process.cwd(), 'scripts', 'eval-toolcall-context-session.ts'),
      '--dry-run',
      '--rounds',
      '3',
      '--output-root',
      outputRoot,
      '--keep-temp',
      'false',
    ],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
    }
  );

  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `dry-run exited with ${String(result.status)}`);
  }

  const summaryPath = path.join(outputRoot, 'toolcall-context-session-report.json');
  return JSON.parse(fs.readFileSync(summaryPath, 'utf8')) as { toolsetName?: string; rounds: Array<{ round: number; prompt: string }> };
}

async function runCase(): Promise<void> {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-toolcall-context-session-'));
  try {
    const dryRun = runDryRun(outputRoot);
    const workPrompt = dryRun.rounds.find((round) => round.round === 2)?.prompt ?? '';
    assert.equal(dryRun.toolsetName, 'windows-dev');
    const reviewPrompt = dryRun.rounds.find((round) => round.round === 3)?.prompt ?? '';

    assert.match(workPrompt, /extract `TOKEN` and copy that exact value into `PREV_TOKEN`/);
    assert.match(workPrompt, /Set `TOKEN` exactly to `work-02`/);
    assert.match(workPrompt, /SEED_CODE=<from seed file>/);
    assert.match(workPrompt, /SEED_VALUE=<from seed file>/);
    assert.match(workPrompt, /PREV_TOKEN=<copy exact previous round TOKEN>/);
    assert.match(workPrompt, /PREV_TOKEN must be the bare token value only/);
    assert.match(workPrompt, /Final answer format is strict/);
    assert.match(workPrompt, /Do not pass `pattern` to `read_file`/);
    assert.match(workPrompt, /do not replace `read_file` with directory listing on file paths/);
    assert.match(workPrompt, /Return only the exact artifact lines followed immediately by the tail marker/);
    assert.match(workPrompt, /Do not use Markdown fences, bullets, headings, summaries, extracted-value sections, explanations, or parenthetical annotations/);
    assert.doesNotMatch(workPrompt, /SEED_CODE=BRV02/);
    assert.doesNotMatch(workPrompt, /SEED_VALUE=bravo-cinder-reef/);
    assert.doesNotMatch(workPrompt, /last 6 characters of PREV_TOKEN/);
    assert.doesNotMatch(workPrompt, /<PREV_SUFFIX>/);
    assert.match(reviewPrompt, /extract `TOKEN` and copy that exact value into `PREV_TOKEN`/);
    assert.match(reviewPrompt, /extract `SEED_CODE` and copy it into `PREV_SEED_CODE`/);
    assert.match(reviewPrompt, /extract `SEED_VALUE` and copy it into `PREV_SEED_VALUE`/);
    assert.match(reviewPrompt, /extract `STATUS` and copy it into `STATUS`/);
    assert.match(reviewPrompt, /Set `TOKEN` exactly to `review-03`/);
    assert.match(reviewPrompt, /SEED_VALUE=<from seed file>/);
    assert.match(reviewPrompt, /PREV_TOKEN=<copy exact previous round TOKEN>/);
    assert.match(reviewPrompt, /PREV_SEED_CODE=<copy exact previous round SEED_CODE>/);
    assert.match(reviewPrompt, /PREV_SEED_VALUE=<copy exact previous round SEED_VALUE>/);
    assert.match(reviewPrompt, /STATUS=<copy exact previous round STATUS>/);
    assert.doesNotMatch(reviewPrompt, /SEED_VALUE=crane-harbor-violet/);
    assert.doesNotMatch(reviewPrompt, /last 6 characters of PREV_TOKEN/);
    assert.doesNotMatch(reviewPrompt, /<PREV_SUFFIX>/);
    assert.match(reviewPrompt, /derive prior-round facts from the real workspace/);
    assert.match(reviewPrompt, /Do not summarize or reinterpret the previous round/);
    assert.match(reviewPrompt, /Final answer format is strict/);
    assert.match(reviewPrompt, /Do not pass `pattern` to `read_file`/);
    assert.match(reviewPrompt, /do not replace `read_file` with directory listing on file paths/);

    const parsedBulletResponse = parseStructuredLines(
      [
        'Verification complete.',
        '- **ROUND**: 03',
        '- **MODE**: REVIEW',
        '- **PREV_SEED_CODE**: BRV02',
        '- **STATUS**: OK',
      ].join('\n')
    );
    assert.deepEqual(parsedBulletResponse, {
      ROUND: '03',
      MODE: 'REVIEW',
      PREV_SEED_CODE: 'BRV02',
      STATUS: 'OK',
    });

    const parsedDecoratedResponse = parseStructuredLines(
      [
        'Verification complete.',
        '- **SEED_CODE=AUR01** (extracted from seed-01.txt)',
        '- **SEED_VALUE=amber-orbit-lantern** (extracted from seed-01.txt)',
        '- **PREV_SEED_VALUE=amber-orbit-lantern** (copied from previous round file)',
        '- **PREV_TOKEN=work-29** (copied exactly from previous round-29.txt)',
      ].join('\n')
    );
    assert.deepEqual(parsedDecoratedResponse, {
      SEED_CODE: 'AUR01',
      SEED_VALUE: 'amber-orbit-lantern',
      PREV_SEED_VALUE: 'amber-orbit-lantern',
      PREV_TOKEN: 'work-29',
    });

    const parsedPlainAnnotatedResponse = parseStructuredLines(
      [
        'Verification complete.',
        'PREV_TOKEN=work-29 (guessed)',
        'STATUS=OK (estimated)',
      ].join('\n')
    );
    assert.deepEqual(parsedPlainAnnotatedResponse, {
      PREV_TOKEN: 'work-29 (guessed)',
      STATUS: 'OK (estimated)',
    });

    const parsedTrailingStructuredBlock = parseStructuredLines(
      [
        'Verification complete.',
        '- TOKEN: work-01',
        '- PREV_TOKEN: work-01',
        '',
        'ROUND=02',
        'MODE=WORK',
        'TOKEN=work-02',
        'SEED_CODE=BRV02',
        'SEED_VALUE=bravo-cinder-reef',
        'PREV_TOKEN=work-01',
        'STATUS=OK',
      ].join('\n')
    );
    assert.deepEqual(parsedTrailingStructuredBlock, {
      ROUND: '02',
      MODE: 'WORK',
      TOKEN: 'work-02',
      SEED_CODE: 'BRV02',
      SEED_VALUE: 'bravo-cinder-reef',
      PREV_TOKEN: 'work-01',
      STATUS: 'OK',
    });

    assert.deepEqual(detectCompletionMarker('STATUS=OK\n\u3010\u5b8c\u6210\uff01\u3011'), {
      matched: true,
      marker: '\u3010\u5b8c\u6210\uff01\u3011',
      duplicateTail: false,
    });
    assert.deepEqual(detectCompletionMarker('```text\nSTATUS=OK\n\u3010\u5b8c\u6210\uff01\u3011\n```'), {
      matched: true,
      marker: '\u3010\u5b8c\u6210\uff01\u3011',
      duplicateTail: false,
    });
    assert.equal(detectCompletionMarker('STATUS=OK\n\u3010\u5b8c\u6210\uff01\u3011\nextra').matched, false);

    const operationValidation = validateRequiredOperations(
      [
        { name: 'read_file', toolCallId: 'bad-read', args: { path: 'session-files/round-02.txt' } },
        { name: 'read_file', toolCallId: 'good-read', args: { path: 'session-files/round-02.txt' } },
      ],
      [
        { name: 'read_file', toolCallId: 'bad-read', content: 'Error: access denied', contentPreview: 'Error: access denied' },
        { name: 'read_file', toolCallId: 'good-read', content: 'ROUND=02', contentPreview: 'ROUND=02' },
      ],
      [{ label: 'read_previous', name: 'read_file', args: { path: 'session-files/round-02.txt' } }]
    );
    assert.deepEqual(operationValidation.validatedOperations, ['read_previous']);
    assert.deepEqual(operationValidation.flags, []);

    const unorderedOperationValidation = validateRequiredOperations(
      [
        { name: 'list_directory', toolCallId: 'list-seeds', args: { path: 'seeds' } },
        { name: 'read_file', toolCallId: 'read-prev', args: { path: 'session-files/round-03.txt' } },
        { name: 'grep', toolCallId: 'grep-tokens', args: { path: 'session-files', pattern: '^TOKEN=' } },
        { name: 'read_file', toolCallId: 'read-seed', args: { path: 'seeds/seed-04.txt' } },
        { name: 'write_file', toolCallId: 'write-out', args: { path: 'session-files/round-04.txt', content: 'ROUND=04' } },
        { name: 'read_file', toolCallId: 'verify-out', args: { path: 'session-files/round-04.txt' } },
      ],
      [
        { name: 'list_directory', toolCallId: 'list-seeds', content: 'FILE seed-04.txt', contentPreview: 'FILE seed-04.txt' },
        { name: 'read_file', toolCallId: 'read-prev', content: 'ROUND=03', contentPreview: 'ROUND=03' },
        { name: 'grep', toolCallId: 'grep-tokens', content: 'round-03.txt:3:TOKEN=review-03', contentPreview: 'round-03.txt:3:TOKEN=review-03' },
        { name: 'read_file', toolCallId: 'read-seed', content: 'SEED_CODE=DLT04', contentPreview: 'SEED_CODE=DLT04' },
        { name: 'write_file', toolCallId: 'write-out', content: 'Successfully wrote 8 characters', contentPreview: 'Successfully wrote 8 characters' },
        { name: 'read_file', toolCallId: 'verify-out', content: 'ROUND=04', contentPreview: 'ROUND=04' },
      ],
      [
        { label: 'list_seeds', name: 'list_directory', args: { path: 'seeds' } },
        { label: 'read_seed', name: 'read_file', args: { path: 'seeds/seed-04.txt' } },
        { label: 'read_previous', name: 'read_file', args: { path: 'session-files/round-03.txt' } },
        { label: 'grep_existing_tokens', name: 'grep', args: { path: 'session-files', pattern: '^TOKEN=' } },
        { label: 'write_output', name: 'write_file', args: { path: 'session-files/round-04.txt', content: 'ROUND=04' } },
        { label: 'verify_output', name: 'read_file', args: { path: 'session-files/round-04.txt' } },
      ]
    );
    assert.deepEqual(unorderedOperationValidation.validatedOperations, [
      'list_seeds',
      'read_seed',
      'read_previous',
      'grep_existing_tokens',
      'write_output',
      'verify_output',
    ]);
    assert.deepEqual(unorderedOperationValidation.flags, []);

    const writeBeforeGrepValidation = validateRequiredOperations(
      [
        { name: 'list_directory', toolCallId: 'list-seeds', args: { path: 'seeds' } },
        { name: 'read_file', toolCallId: 'read-seed', args: { path: 'seeds/seed-04.txt' } },
        { name: 'read_file', toolCallId: 'read-prev', args: { path: 'session-files/round-03.txt' } },
        { name: 'write_file', toolCallId: 'write-out', args: { path: 'session-files/round-04.txt', content: 'ROUND=04' } },
        { name: 'grep', toolCallId: 'grep-tokens', args: { path: 'session-files', pattern: '^TOKEN=' } },
        { name: 'read_file', toolCallId: 'verify-out', args: { path: 'session-files/round-04.txt' } },
      ],
      [
        { name: 'list_directory', toolCallId: 'list-seeds', content: 'FILE seed-04.txt', contentPreview: 'FILE seed-04.txt' },
        { name: 'read_file', toolCallId: 'read-seed', content: 'SEED_CODE=DLT04', contentPreview: 'SEED_CODE=DLT04' },
        { name: 'read_file', toolCallId: 'read-prev', content: 'ROUND=03', contentPreview: 'ROUND=03' },
        { name: 'write_file', toolCallId: 'write-out', content: 'Successfully wrote 8 characters', contentPreview: 'Successfully wrote 8 characters' },
        { name: 'grep', toolCallId: 'grep-tokens', content: 'round-03.txt:3:TOKEN=review-03', contentPreview: 'round-03.txt:3:TOKEN=review-03' },
        { name: 'read_file', toolCallId: 'verify-out', content: 'ROUND=04', contentPreview: 'ROUND=04' },
      ],
      [
        { label: 'list_seeds', name: 'list_directory', args: { path: 'seeds' } },
        { label: 'read_seed', name: 'read_file', args: { path: 'seeds/seed-04.txt' } },
        { label: 'read_previous', name: 'read_file', args: { path: 'session-files/round-03.txt' } },
        { label: 'grep_existing_tokens', name: 'grep', args: { path: 'session-files', pattern: '^TOKEN=' } },
        { label: 'write_output', name: 'write_file', args: { path: 'session-files/round-04.txt', content: 'ROUND=04' } },
        { label: 'verify_output', name: 'read_file', args: { path: 'session-files/round-04.txt' } },
      ]
    );
    assert.deepEqual(writeBeforeGrepValidation.validatedOperations, [
      'list_seeds',
      'read_seed',
      'read_previous',
      'grep_existing_tokens',
      'write_output',
      'verify_output',
    ]);
    assert.deepEqual(writeBeforeGrepValidation.flags, [
      'required_operation_order:grep_existing_tokens_before_write_output',
    ]);

    const previousState = {
      round: 7,
      token: 'review-06',
      uniqueToolNames: ['list_directory', 'read_file', 'write_file'],
      seedCode: 'GLD07',
      seedValue: 'glide-maple-anvil',
      status: 'OK',
    };
    const nextState = previousRuntimeFromEvaluation(
      previousState,
      {
        round: 8,
        mode: 'work',
        seed: { index: 8, code: 'HRZ08', value: 'horizon-cobalt-mirror' },
        outputPath: 'session-files/round-08.txt',
        prompt: 'prompt',
        expectedFields: { TOKEN: 'work-08' },
        expectedArtifact: 'TOKEN=work-08',
        requiredTools: ['list_directory', 'read_file', 'write_file'],
        requiredOperations: [],
        minToolCalls: 3,
      },
      {
        round: 8,
        mode: 'work',
        prompt: 'prompt',
        outputPath: 'session-files/round-08.txt',
        finishReason: 'end_turn',
        response: 'bad response',
        responseFields: {},
        fileFields: {},
        expectedFields: { TOKEN: 'work-08' },
        expectedArtifact: 'TOKEN=work-08',
        toolCalls: [{ name: 'list_directory', toolCallId: 'call-1', args: { path: 'seeds' } }],
        toolResults: [{ name: 'list_directory', toolCallId: 'call-1', content: '[]', contentPreview: '[]' }],
        uniqueToolNames: ['list_directory'],
        requiredToolsMissing: ['read_file', 'write_file'],
        markerMatched: true,
        matchedMarker: '【完成！】',
        responseMatchesExpected: false,
        fileMatchesExpected: false,
        toolCallCount: 1,
        minToolCalls: 3,
        validatedOperations: [],
        toolValidationFlags: ['required_operation_mismatch:write_output'],
        flags: ['artifact_field_mismatch'],
        ok: false,
      }
    );
    assert.equal(nextState.round, 8);
    assert.equal(nextState.token, 'review-06');
    assert.deepEqual(nextState.uniqueToolNames, ['list_directory']);
    assert.equal(nextState.seedCode, 'GLD07');
    assert.equal(nextState.seedValue, 'glide-maple-anvil');
    assert.equal(nextState.status, 'OK');
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true });
  }
}

runCase()
  .then(() => {
    console.log('eval-toolcall-context-session test passed');
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
