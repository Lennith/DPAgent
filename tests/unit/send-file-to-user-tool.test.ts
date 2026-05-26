import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createSendFileToUserTool } from '../../src/tools/index.js';
import type { SendFileToUserLinkIssuer } from '../../src/tools/index.js';

function createHarness(): { tempDir: string; workspaceDir: string; filePath: string } {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'send-file-tool-'));
  const workspaceDir = path.join(tempDir, 'workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });
  const filePath = path.join(workspaceDir, 'report.md');
  fs.writeFileSync(filePath, '# report\n', 'utf-8');
  return { tempDir, workspaceDir, filePath };
}

function cleanup(tempDir: string): void {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

function createIssuer(): { issuer: SendFileToUserLinkIssuer; calls: Array<{ absolutePath: string; displayPath: string }> } {
  const calls: Array<{ absolutePath: string; displayPath: string }> = [];
  return {
    calls,
    issuer: {
      createDownloadLink(input) {
        calls.push({ absolutePath: input.absolutePath, displayPath: input.displayPath });
        return {
          href: `http://localhost:53721/download/id/${input.filename}`,
          displayPath: input.displayPath,
          filename: input.filename,
          size: input.size,
          expiresAt: '2026-05-08T00:00:00.000Z',
        };
      },
    },
  };
}

async function testCreatesDownloadLink(): Promise<void> {
  const harness = createHarness();
  try {
    const { issuer, calls } = createIssuer();
    const tool = createSendFileToUserTool({
      workspaceDir: harness.workspaceDir,
      linkIssuer: issuer,
    });

    assert.match(tool.description, /send, provide, attach, or share/i);
    assert.match(tool.description, /href/i);
    assert.equal((tool.parameters.required as string[]).includes('path'), true);

    const result = await tool.execute({ path: 'report.md' });
    assert.equal(result.success, true);
    const payload = JSON.parse(result.content) as { success: boolean; href: string; displayPath: string; filename: string; size: number };
    assert.equal(payload.success, true);
    assert.equal(payload.href, 'http://localhost:53721/download/id/report.md');
    assert.equal(payload.displayPath, path.normalize(harness.filePath));
    assert.equal(payload.filename, 'report.md');
    assert.equal(payload.size, 9);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].absolutePath, harness.filePath);
  } finally {
    cleanup(harness.tempDir);
  }
}

async function testRejectsMissingDirectoryAndDeniedPaths(): Promise<void> {
  const harness = createHarness();
  try {
    const { issuer } = createIssuer();
    const deniedTool = createSendFileToUserTool({
      workspaceDir: harness.workspaceDir,
      linkIssuer: issuer,
      checkPermission: () => ({ allowed: false, reason: 'no read' }),
    });
    const denied = await deniedTool.execute({ path: 'report.md' });
    assert.equal(denied.success, false);
    assert.match(String(denied.error), /no read/);

    const tool = createSendFileToUserTool({
      workspaceDir: harness.workspaceDir,
      linkIssuer: issuer,
    });
    const missing = await tool.execute({ path: 'missing.md' });
    assert.equal(missing.success, false);
    assert.match(String(missing.error), /File not found/);

    const directory = await tool.execute({ path: '.' });
    assert.equal(directory.success, false);
    assert.match(String(directory.error), /not a file/);
  } finally {
    cleanup(harness.tempDir);
  }
}

async function runAll(): Promise<void> {
  await testCreatesDownloadLink();
  await testRejectsMissingDirectoryAndDeniedPaths();
  console.log('send-file-to-user-tool tests passed');
}

void runAll();
