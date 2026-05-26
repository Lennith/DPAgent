import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DownloadLinkService } from '../../src/web/server/download-link-service.js';
import { registerDownloadRoutes } from '../../src/web/server/web-server-download-routes.js';
import { createResponseRecorder, createRouteAppHarness, type CapturedRoute } from './helpers/web-route-harness.js';

function createService(input: {
  tempDir: string;
  now?: () => Date;
  ttlMs?: number;
  publicBaseUrl?: string;
}): DownloadLinkService {
  return new DownloadLinkService({
    runtimeDataDir: path.join(input.tempDir, 'runtime'),
    publicBaseUrl: input.publicBaseUrl ?? 'http://example.test:53721/',
    ttlMs: input.ttlMs,
    now: input.now,
  });
}

function registerRoute(service: DownloadLinkService): CapturedRoute {
  const routes = createRouteAppHarness();
  registerDownloadRoutes({
    app: routes.app,
    downloadServices: {
      downloadLinks: service,
    },
  } as any);
  const route = routes.getRouteList.find((item) => item.path === '/download/:id/:filename?');
  assert.ok(route);
  return route;
}

function testCreatesPersistentOpaqueLinkAndRouteDownload(): void {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'download-routes-'));
  try {
    const filePath = path.join(tempDir, 'file.md');
    fs.writeFileSync(filePath, 'download me', 'utf-8');
    const service = createService({ tempDir });
    const record = service.createLink({
      absolutePath: filePath,
      displayPath: filePath,
      filename: 'file.md',
      size: 11,
    });

    assert.match(record.href, /^http:\/\/example\.test:53721\/download\/[a-f0-9]{36}\/file\.md$/);
    assert.doesNotMatch(record.href, /filePath|download-routes|[A-Z]:/);
    assert.equal(fs.existsSync(path.join(tempDir, 'runtime', 'download-links.json')), true);

    const reloaded = createService({ tempDir });
    assert.equal(reloaded.resolve(record.id)?.absolutePath, filePath);

    const route = registerRoute(reloaded);
    const res = createResponseRecorder();
    route.handler({ params: { id: record.id } }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.downloaded, { filePath, filename: 'file.md' });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function testRouteRejectsUnknownAndExpiredLinks(): void {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'download-routes-expired-'));
  let now = new Date('2026-05-07T00:00:00.000Z');
  try {
    const filePath = path.join(tempDir, 'file.md');
    fs.writeFileSync(filePath, 'download me', 'utf-8');
    const service = createService({
      tempDir,
      ttlMs: 1000,
      now: () => now,
    });
    const record = service.createLink({
      absolutePath: filePath,
      displayPath: filePath,
      filename: 'file.md',
    });
    now = new Date('2026-05-07T00:00:02.000Z');
    const route = registerRoute(service);

    const expiredRes = createResponseRecorder();
    route.handler({ params: { id: record.id } }, expiredRes);
    assert.equal(expiredRes.statusCode, 404);

    const unknownRes = createResponseRecorder();
    route.handler({ params: { id: 'not-valid' } }, unknownRes);
    assert.equal(unknownRes.statusCode, 404);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function testCreatesSameOriginLinkWhenPublicBaseUrlIsUnset(): void {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'download-routes-relative-'));
  try {
    const filePath = path.join(tempDir, 'file.md');
    fs.writeFileSync(filePath, 'download me', 'utf-8');
    const service = createService({ tempDir, publicBaseUrl: '' });
    const record = service.createLink({
      absolutePath: filePath,
      displayPath: filePath,
      filename: 'file.md',
    });

    assert.match(record.href, /^\/download\/[a-f0-9]{36}\/file\.md$/);
    assert.doesNotMatch(record.href, /localhost/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function testRejectsPathReplacementAfterIssue(): void {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'download-routes-replaced-'));
  try {
    const filePath = path.join(tempDir, 'file.md');
    const originalPath = path.join(tempDir, 'original-file.md');
    fs.writeFileSync(filePath, 'authorized original', 'utf-8');
    const service = createService({ tempDir });
    const record = service.createLink({
      absolutePath: filePath,
      displayPath: filePath,
      filename: 'file.md',
    });

    fs.renameSync(filePath, originalPath);
    fs.writeFileSync(filePath, 'replacement content', 'utf-8');

    const route = registerRoute(service);
    const res = createResponseRecorder();
    route.handler({ params: { id: record.id } }, res);
    assert.equal(res.statusCode, 404);
    assert.equal(res.downloaded, undefined);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function runAll(): void {
  testCreatesPersistentOpaqueLinkAndRouteDownload();
  testRouteRejectsUnknownAndExpiredLinks();
  testCreatesSameOriginLinkWhenPublicBaseUrlIsUnset();
  testRejectsPathReplacementAfterIssue();
  console.log('web-download-routes tests passed');
}

runAll();
