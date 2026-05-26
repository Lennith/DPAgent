import * as assert from 'node:assert/strict';
import { resolveSessionLlmPopoverPosition } from '../../src/web/client/components/chat/session-llm-popover-position.js';

function testPopoverStaysWithinNarrowComposer(): void {
  const position = resolveSessionLlmPopoverPosition({
    viewportWidth: 1024,
    viewportHeight: 768,
    anchorRect: { left: 366, right: 894, top: 248, bottom: 720, width: 528, height: 472 },
    triggerRect: { left: 536, right: 894, top: 263, width: 358 },
  });

  assert.equal(position.left, 0);
  assert.equal(position.width, 528);
  assert.equal(position.bottom, 484);
}

function testPopoverUsesMaxWidthAndRightAlignsInWideComposer(): void {
  const position = resolveSessionLlmPopoverPosition({
    viewportWidth: 1920,
    viewportHeight: 1080,
    anchorRect: { left: 390, right: 1570, top: 840, bottom: 1048, width: 1180, height: 208 },
    triggerRect: { left: 1220, right: 1570, top: 858, width: 350 },
  });

  assert.equal(position.width, 720);
  assert.equal(position.left, 460);
  assert.equal(position.bottom, 220);
}

function testPopoverClampsToViewportMargin(): void {
  const position = resolveSessionLlmPopoverPosition({
    viewportWidth: 390,
    viewportHeight: 844,
    anchorRect: { left: 8, right: 382, top: 620, bottom: 828, width: 374, height: 208 },
    triggerRect: { left: 160, right: 382, top: 636, width: 222 },
  });

  assert.equal(position.left, 4);
  assert.equal(position.width, 366);
  assert.equal(position.bottom, 220);
}

function testPopoverDoesNotDoubleApplyComposerOffsetInFullscreen(): void {
  const position = resolveSessionLlmPopoverPosition({
    viewportWidth: 1900,
    viewportHeight: 920,
    anchorRect: { left: 325, right: 1443, top: 658.5, bottom: 893, width: 1118, height: 234.5 },
    triggerRect: { left: 460, right: 744.9375, top: 720, width: 284.9375 },
  });

  assert.equal(position.left, 0);
  assert.equal(position.width, 720);
  assert.equal(position.bottom, 246.5);
}

function runAll(): void {
  testPopoverStaysWithinNarrowComposer();
  testPopoverUsesMaxWidthAndRightAlignsInWideComposer();
  testPopoverClampsToViewportMargin();
  testPopoverDoesNotDoubleApplyComposerOffsetInFullscreen();
  console.log('session-llm-popover-position tests passed');
}

runAll();
