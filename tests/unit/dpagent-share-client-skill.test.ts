import * as assert from 'node:assert/strict';
import { createServer } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';
import { resolveDpAgentAssistantSkillScript } from '../helpers/dpagent-assistant-skill-paths.js';

function runNodeScript(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const scriptPath = resolveDpAgentAssistantSkillScript(
    'dpagent-share-client',
    path.join('scripts', 'dpagent_share_client.mjs')
  );
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

async function withTestServer<T>(handler: (baseUrl: string, observed: string[]) => Promise<T>): Promise<T> {
  const observed: string[] = [];
  const server = createServer((req, res) => {
    observed.push(`${req.method} ${req.url}`);
    if (req.url === '/api/share/test-token/text-history?turns=1') {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          sessionId: 'sess-skill',
          turns: 1,
          messages: [
            { role: 'user', content: 'previous question' },
            { role: 'assistant', content: 'previous answer' },
          ],
        })
      );
      return;
    }
    if (req.url === '/download/id/hello.py') {
      observed.push(`DOWNLOAD_TOKEN ${String(req.headers['x-dpagent-share-token'] ?? '')}`);
      res.setHeader('content-type', 'text/x-python');
      res.end('print("Hello, World!")\n');
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws, req) => {
    observed.push(`WS ${req.url}`);
    ws.on('message', (raw) => {
      const message = JSON.parse(raw.toString()) as { type?: string; data?: { text?: string } };
      observed.push(`IN ${message.type}:${message.data?.text ?? ''}`);
      if (message.type === 'ask_text') {
        ws.send(JSON.stringify({ type: 'thinking', data: { thinking: 'must be ignored' } }));
        ws.send(JSON.stringify({ type: 'text_delta', data: { content: 'print(' } }));
        ws.send(JSON.stringify({ type: 'text_delta', data: { content: '"Hello, World!")' } }));
        ws.send(
          JSON.stringify({
            type: 'file_link',
            data: {
              href: `${baseUrl}/download/id/hello.py`,
              displayPath: 'D:\\repo\\hello.py',
              filename: 'hello.py',
            },
          })
        );
        ws.send(JSON.stringify({ type: 'done', data: { content: 'print("Hello, World!")' } }));
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    return await handler(baseUrl, observed);
  } finally {
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function testHistoryCommandParsesShareLinkAndTurns(): Promise<void> {
  await withTestServer(async (baseUrl, observed) => {
    const result = await runNodeScript([
      'get_history',
      '--share-link',
      `${baseUrl}/dpagent-share/test-token`,
      '--turns',
      '1',
    ]);

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      sessionId: 'sess-skill',
      turns: 1,
      messages: [
        { role: 'user', content: 'previous question' },
        { role: 'assistant', content: 'previous answer' },
      ],
    });
    assert.ok(observed.includes('GET /api/share/test-token/text-history?turns=1'));
  });
}

async function testRejectsOldShareLinkPath(): Promise<void> {
  await withTestServer(async (baseUrl) => {
    const result = await runNodeScript([
      'get_history',
      '--share-link',
      `${baseUrl}/share/test-token`,
    ]);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /Share link must contain \/dpagent-share\/<token>/);
  });
}

async function testAskCommandReturnsOnlyFinalText(): Promise<void> {
  await withTestServer(async (baseUrl, observed) => {
    const result = await runNodeScript([
      'ask',
      '--share-link',
      `${baseUrl}/dpagent-share/test-token`,
      '--text',
      'Write hello world python',
      '--timeout-ms',
      '5000',
    ]);

    assert.equal(result.code, 0, result.stderr);
    assert.equal(
      result.stdout.trim(),
      [
        'print("Hello, World!")',
        '',
        'Files:',
        `- D:\\repo\\hello.py: ${baseUrl}/download/id/hello.py`,
      ].join('\n')
    );
    assert.equal(result.stdout.includes('previous question'), false);
    assert.equal(result.stdout.includes('must be ignored'), false);
    assert.ok(observed.some((item) => item.startsWith('WS /ws?')));
    assert.ok(observed.some((item) => item === 'IN ask_text:Write hello world python'));
  });
}

async function testAskCommandDownloadsFileLinksToRequestedDirectory(): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dpagent-share-download-'));
  try {
    await withTestServer(async (baseUrl, observed) => {
      const result = await runNodeScript([
        'ask',
        '--share-link',
        `${baseUrl}/dpagent-share/test-token`,
        '--text',
        'Write hello world python and send the file',
        '--download-dir',
        tempDir,
        '--timeout-ms',
        '5000',
      ]);

      const downloadedPath = path.join(tempDir, 'hello.py');
      assert.equal(result.code, 0, result.stderr);
      assert.equal(fs.readFileSync(downloadedPath, 'utf-8'), 'print("Hello, World!")\n');
      assert.match(result.stdout, /Downloaded files:/);
      assert.match(result.stdout, /hello\.py/);
      assert.ok(observed.includes('DOWNLOAD_TOKEN test-token'));
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function runAll(): Promise<void> {
  await testHistoryCommandParsesShareLinkAndTurns();
  await testRejectsOldShareLinkPath();
  await testAskCommandReturnsOnlyFinalText();
  await testAskCommandDownloadsFileLinksToRequestedDirectory();
  console.log('dpagent-share-client-skill tests passed');
}

runAll().catch((error) => {
  console.error(error);
  process.exit(1);
});
