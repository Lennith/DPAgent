import * as assert from 'node:assert/strict';
import {
  getChatDistanceFromBottom,
  isChatScrolledNearBottom,
  shouldAutoScrollToLatest,
} from '../../src/web/client/components/chat/chat-scroll-policy.js';

function testDistanceFromBottom(): void {
  assert.equal(getChatDistanceFromBottom({ scrollTop: 700, scrollHeight: 1000, clientHeight: 250 }), 50);
  assert.equal(getChatDistanceFromBottom({ scrollTop: 900, scrollHeight: 1000, clientHeight: 250 }), 0);
}

function testNearBottomThreshold(): void {
  assert.equal(isChatScrolledNearBottom({ scrollTop: 704, scrollHeight: 900, clientHeight: 100 }), true);
  assert.equal(isChatScrolledNearBottom({ scrollTop: 690, scrollHeight: 900, clientHeight: 100 }), false);
}

function testAutoScrollDecision(): void {
  assert.equal(shouldAutoScrollToLatest({
    sessionChanged: false,
    wasNearBottomBeforeUpdate: false,
    latestMessageRole: 'assistant',
  }), false);
  assert.equal(shouldAutoScrollToLatest({
    sessionChanged: false,
    wasNearBottomBeforeUpdate: true,
    latestMessageRole: 'assistant',
  }), true);
  assert.equal(shouldAutoScrollToLatest({
    sessionChanged: false,
    wasNearBottomBeforeUpdate: false,
    latestMessageRole: 'user',
  }), true);
  assert.equal(shouldAutoScrollToLatest({
    sessionChanged: true,
    wasNearBottomBeforeUpdate: false,
    latestMessageRole: 'assistant',
  }), true);
}

testDistanceFromBottom();
testNearBottomThreshold();
testAutoScrollDecision();

console.log('chat-scroll-policy tests passed');
