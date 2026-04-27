import * as assert from 'node:assert/strict';
import {
  createPlanInputErrorMessage,
  createPlanInputResolvedMessage,
} from '../../src/web/server/plan-input-response-messages.js';
import type { ContextRef } from '../../src/types.js';

function testErrorMessageSupportsSparseAndRichPayloads(): void {
  const context: ContextRef = { scope: 'session', namespace: 'sess-1' };

  assert.deepEqual(
    createPlanInputErrorMessage({ error: 'runId is required for plan_input_response' }),
    {
      type: 'plan_input_error',
      data: {
        error: 'runId is required for plan_input_response',
      },
    }
  );

  assert.deepEqual(
    createPlanInputErrorMessage({
      runId: 'run-1',
      requestId: 'req-1',
      error: 'answers must be an array',
    }),
    {
      type: 'plan_input_error',
      data: {
        runId: 'run-1',
        requestId: 'req-1',
        error: 'answers must be an array',
      },
    }
  );

  assert.deepEqual(
    createPlanInputErrorMessage({
      runId: 'run-1',
      context,
      requestId: 'req-1',
      error: 'run_completed',
    }),
    {
      type: 'plan_input_error',
      data: {
        runId: 'run-1',
        context,
        requestId: 'req-1',
        error: 'run_completed',
      },
    }
  );
}

function testResolvedMessagePreservesRequiredFields(): void {
  const context: ContextRef = { scope: 'session', namespace: 'sess-1' };

  assert.deepEqual(
    createPlanInputResolvedMessage({
      runId: 'run-1',
      context,
      requestId: 'req-1',
    }),
    {
      type: 'plan_input_resolved',
      data: {
        runId: 'run-1',
        context,
        requestId: 'req-1',
      },
    }
  );
}

function testWireShapeOmitsUndefinedFields(): void {
  assert.deepEqual(
    JSON.parse(JSON.stringify(createPlanInputErrorMessage({ error: 'runId is required for plan_input_response' }))),
    {
      type: 'plan_input_error',
      data: {
        error: 'runId is required for plan_input_response',
      },
    }
  );

  assert.deepEqual(
    JSON.parse(
      JSON.stringify(
        createPlanInputErrorMessage({
          runId: 'run-1',
          requestId: 'req-1',
          error: 'answers must be an array',
        })
      )
    ),
    {
      type: 'plan_input_error',
      data: {
        runId: 'run-1',
        requestId: 'req-1',
        error: 'answers must be an array',
      },
    }
  );
}

function runAll(): void {
  testErrorMessageSupportsSparseAndRichPayloads();
  testResolvedMessagePreservesRequiredFields();
  testWireShapeOmitsUndefinedFields();
  console.log('web-plan-input-response-messages tests passed');
}

runAll();
