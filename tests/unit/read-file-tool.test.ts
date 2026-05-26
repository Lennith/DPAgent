import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ReadFileTool } from '../../src/tools/index.js';

function createWorkspace(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `read-file-tool-${prefix}-`));
}

function writeLines(filePath: string, count: number, lineFactory: (index: number) => string = (index) => `line-${index}`): void {
  fs.writeFileSync(filePath, Array.from({ length: count }, (_value, index) => lineFactory(index)).join('\n'), 'utf8');
}

async function testDefaultLimitReturnsFirstFourHundredLines(): Promise<void> {
  const workspaceDir = createWorkspace('default-limit');
  try {
    const filePath = path.join(workspaceDir, 'large.txt');
    writeLines(filePath, 450);
    const tool = new ReadFileTool({ workspaceDir });

    const result = await tool.execute({ path: 'large.txt' });

    assert.equal(result.success, true);
    assert.match(result.content, /\[READ_FILE_DEFAULT_LIMIT_APPLIED limit=400\]/);
    assert.match(result.content, /line-399/);
    assert.doesNotMatch(result.content, /line-400/);
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
}

async function testRequestedLimitIsCappedAtTwoThousandLines(): Promise<void> {
  const workspaceDir = createWorkspace('max-lines');
  try {
    const filePath = path.join(workspaceDir, 'large.txt');
    writeLines(filePath, 2501);
    const tool = new ReadFileTool({ workspaceDir });

    const result = await tool.execute({ path: 'large.txt', limit: 5000 });

    assert.equal(result.success, true);
    assert.match(result.content, /\[READ_FILE_LIMIT_CAPPED requested=5000 max=2000\]/);
    assert.match(result.content, /line-1999/);
    assert.doesNotMatch(result.content, /line-2000/);
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
}

async function testOutputCharsAreCapped(): Promise<void> {
  const workspaceDir = createWorkspace('max-chars');
  try {
    const filePath = path.join(workspaceDir, 'wide.txt');
    writeLines(filePath, 2000, (index) => `${index}: ${'x'.repeat(300)}`);
    const tool = new ReadFileTool({ workspaceDir });

    const result = await tool.execute({ path: 'wide.txt', limit: 2000 });

    assert.equal(result.success, true);
    assert.match(result.content, /\[READ_FILE_OUTPUT_TRUNCATED max_chars=240000\]/);
    assert.ok(result.content.length < 242000);
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
}

async function testScanBytesAreCapped(): Promise<void> {
  const workspaceDir = createWorkspace('max-scan');
  try {
    const filePath = path.join(workspaceDir, 'scan.txt');
    fs.writeFileSync(filePath, 'a\n'.repeat(8 * 1024 * 1024 + 100), 'utf8');
    const tool = new ReadFileTool({ workspaceDir });

    const result = await tool.execute({ path: 'scan.txt', offset: 10_000_000, limit: 1 });

    assert.equal(result.success, true);
    assert.match(result.content, /\[READ_FILE_SCAN_LIMIT_REACHED max_scan_bytes=16777216\]/);
  } finally {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
}

async function runAll(): Promise<void> {
  await testDefaultLimitReturnsFirstFourHundredLines();
  await testRequestedLimitIsCappedAtTwoThousandLines();
  await testOutputCharsAreCapped();
  await testScanBytesAreCapped();
  console.log('read-file-tool tests passed');
}

runAll().catch((error) => {
  console.error(error);
  process.exit(1);
});
