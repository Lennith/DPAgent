import * as assert from 'node:assert/strict';
import fs from 'fs';
import { registerGuideRoutes } from '../../src/web/server/web-server-guide-routes.js';
import { createResponseRecorder, createRouteAppHarness } from './helpers/web-route-harness.js';

interface ReadFileCall {
  filePath: string;
  options: unknown;
}

function withGuideMarkdown(markdown: string, callback: (calls: ReadFileCall[]) => void): void {
  const originalReadFileSync = fs.readFileSync;
  const calls: ReadFileCall[] = [];
  (fs as unknown as { readFileSync: typeof fs.readFileSync }).readFileSync = ((
    filePath: fs.PathOrFileDescriptor,
    options?: unknown
  ) => {
    calls.push({ filePath: String(filePath), options });
    if (options && typeof options !== 'string' && !(options instanceof String)) {
      return Buffer.from(markdown);
    }
    return markdown;
  }) as typeof fs.readFileSync;
  try {
    callback(calls);
  } finally {
    (fs as unknown as { readFileSync: typeof fs.readFileSync }).readFileSync = originalReadFileSync;
  }
}

function testGuideRouteRendersMarkdown(): void {
  const routes = createRouteAppHarness();
  registerGuideRoutes(routes.app as any);
  const guideRoute = routes.getRoutes.get('/guide/user-guide');
  assert.ok(guideRoute);

  withGuideMarkdown(
    [
      '# DPAgent 用户指南',
      '',
      '普通用户可以打开 `npx dpagent`，也可以访问 [指南](./user-guide)。',
      '',
      '![主界面](assets/user-guide/main-ui.svg)',
      '',
      '- 会话',
      '- 分享',
      '',
      '```text',
      '<unsafe>',
      '```',
    ].join('\n'),
    (calls) => {
      const res = createResponseRecorder();
      guideRoute({}, res);
      const page = String(res.body ?? '');

      assert.equal(calls.length, 1);
      assert.equal(calls[0].options, 'utf8');
      assert.match(calls[0].filePath.replace(/\\/g, '/'), /\/doc\/guide\/user-guide\.md$/);
      assert.equal(res.statusCode, 200);
      assert.equal(res.contentType, 'html');
      assert.match(page, /^<!doctype html>/);
      assert.match(page, /<html lang="zh-CN">/);
      assert.match(page, /<title>DPAgent 用户指南<\/title>/);
      assert.match(page, /href="\/"/);
      assert.match(page, /<h1 id="dpagent-/);
      assert.match(page, /<code>npx dpagent<\/code>/);
      assert.match(page, /<a href="\.\/user-guide">指南<\/a>/);
      assert.match(page, /<img src="assets\/user-guide\/main-ui\.svg" alt="主界面"/);
      assert.match(page, /<ul>\n<li>会话<\/li>\n<li>分享<\/li>\n<\/ul>/);
      assert.match(page, /&lt;unsafe&gt;/);
    }
  );
}

function testRouteRegistration(): void {
  const routes = createRouteAppHarness();

  registerGuideRoutes(routes.app as any);

  const guideRedirect = routes.getRouteList.find((route) => route.path === '/guide');
  assert.ok(guideRedirect);
  const redirectRes = createResponseRecorder();
  guideRedirect.handler({}, redirectRes);
  assert.equal(redirectRes.redirectedTo, '/guide/user-guide');

  const assetRoute = routes.getRouteList.find((route) => route.path === '/guide/assets/user-guide/:file');
  assert.ok(assetRoute);
  const rejectedRes = createResponseRecorder();
  assetRoute.handler({ params: { file: '../secret.svg' } }, rejectedRes);
  assert.equal(rejectedRes.statusCode, 404);
}

testGuideRouteRendersMarkdown();
testRouteRegistration();

console.log('web-guide-routes tests passed');
