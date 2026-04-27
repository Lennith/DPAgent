import * as assert from 'node:assert/strict';
import { AutoLoopController } from '../../src/auto-loop/AutoLoopController.js';
import { ExitAutoLoopTool } from '../../src/tools/ExitAutoLoopTool.js';

async function testExitToolValidation(): Promise<void> {
  const controller = new AutoLoopController('session-test', { enabled: true });
  const tool = new ExitAutoLoopTool({
    isInAutoLoop: () => controller.isInLoop(),
    requestAutoLoopExit: (reason) => controller.requestExit(reason),
  });

  assert.match(tool.description, /Request exit from the current auto-loop/i);
  assert.match(tool.description, /queues loop shutdown/i);

  const beforeStart = await tool.execute({});
  assert.equal(beforeStart.success, false);
  assert.match(beforeStart.error ?? '', /only be called during auto-loop/i);

  controller.start();
  const started = await tool.execute({ reason: 'done' });
  assert.equal(started.success, true);
  assert.match(started.content, /exit requested/i);

  const second = await tool.execute({});
  assert.equal(second.success, true);
  assert.match(second.content, /already requested/i);
}

function testControllerExitStopsContinuation(): void {
  const controller = new AutoLoopController('session-test-2', { enabled: true });
  controller.start();
  const requested = controller.requestExit('done');
  assert.equal(requested.accepted, true);

  const check = controller.shouldContinue('final output');
  assert.equal(check.shouldContinue, false);
  assert.match(check.reason ?? '', /exit_auto_loop requested/i);

  const state = controller.getState();
  assert.equal(state.isRunning, false);
  assert.equal(state.exitRequested, false);
  assert.equal(state.stopReason, 'tool_exit');
}

async function runAll(): Promise<void> {
  await testExitToolValidation();
  testControllerExitStopsContinuation();
  console.log('auto-loop-exit-tool tests passed');
}

runAll().catch((error) => {
  console.error(error);
  process.exit(1);
});
