import * as assert from 'node:assert/strict';
import { buildAgentMentionUrl } from '../../src/web/client/components/chat/agent-mention-url.js';

function runAll(): void {
  assert.equal(buildAgentMentionUrl('', null), '/api/agents');
  assert.equal(buildAgentMentionUrl('Review', null), '/api/agents?query=Review');
  assert.equal(
    buildAgentMentionUrl('', 'token-1'),
    '/api/agents?shareToken=token-1'
  );
  assert.equal(
    buildAgentMentionUrl('Review Agent', 'token-1'),
    '/api/agents?query=Review%20Agent&shareToken=token-1'
  );
  console.log('agent-mention-share-token tests passed');
}

runAll();
