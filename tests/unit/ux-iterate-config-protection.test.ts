import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

function run(): void {
  const filePath = path.resolve(process.cwd(), 'scripts', 'ux-iterate.js');
  const raw = fs.readFileSync(filePath, 'utf8');

  assert.match(raw, /protectExistingDevConfig/);
  assert.match(raw, /SMOKE_NO_SETTINGS_WRITE/);
  assert.match(raw, /if \(protectExistingDevConfig\) \{[\s\S]*skip API key sync\/write[\s\S]*\} else \{[\s\S]*syncApiKeyToServer/);
  assert.match(raw, /function shouldContinueUiFocusedRounds/);
  assert.match(raw, /completedRounds >= args\.rounds/);
  console.log('ux-iterate-config-protection tests passed');
}

run();
