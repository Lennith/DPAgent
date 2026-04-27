import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GovernanceAuditStore } from '../../src/governance/AuditStore.js';

function createHarness(): { tempDir: string; auditDir: string } {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'governance-audit-store-'));
  const auditDir = path.join(tempDir, 'runtime', 'audit');
  return { tempDir, auditDir };
}

function cleanup(tempDir: string): void {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

async function runCase(): Promise<void> {
  const harness = createHarness();
  try {
    const store = new GovernanceAuditStore(harness.auditDir);
    fs.rmSync(path.join(harness.tempDir, 'runtime'), { recursive: true, force: true });

    const event = store.append({
      kind: 'memory_organize_queued',
      title: 'Queued after runtime cleanup',
      sessionId: 'sess-1',
    });

    assert.equal(event.kind, 'memory_organize_queued');
    assert.equal(fs.existsSync(path.join(harness.auditDir, 'events.jsonl')), true);

    const listed = store.list({ sessionId: 'sess-1' });
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.title, 'Queued after runtime cleanup');
  } finally {
    cleanup(harness.tempDir);
  }
}

runCase()
  .then(() => {
    console.log('governance-audit-store tests passed');
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
