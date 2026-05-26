import * as assert from 'node:assert/strict';
import { SessionShareService } from '../../src/web/server/session-share-service.js';
import type { ContextNamespaceMeta, ContextRef } from '../../src/types.js';

function createAgent(initialMeta?: Partial<ContextNamespaceMeta>) {
  let meta: ContextNamespaceMeta = {
    scope: 'session',
    namespace: 'sess-1',
    createdAt: '2026-05-07T00:00:00.000Z',
    updatedAt: '2026-05-07T00:00:00.000Z',
    ...initialMeta,
  };
  return {
    get meta() {
      return meta;
    },
    getContextNamespaceMeta: (context: ContextRef) =>
      context.scope === 'session' && context.namespace === meta.namespace ? meta : undefined,
    updateContextNamespaceMeta: (context: ContextRef, patch: Partial<ContextNamespaceMeta>) => {
      assert.deepEqual(context, { scope: 'session', namespace: meta.namespace });
      meta = {
        ...meta,
        ...patch,
      };
      return meta;
    },
    getContextManager: () => ({
      listNamespaces: () => [meta],
    }),
  };
}

function testCreateStoresHashAndReturnsPlainTokenOnce(): void {
  const agent = createAgent();
  const service = new SessionShareService({
    agent: agent as any,
    now: () => new Date('2026-05-07T01:00:00.000Z'),
    randomToken: () => 'plain-token',
    publicBaseUrl: () => 'http://localhost:3000/',
  });

  const created = service.create('sess-1');

  assert.equal(created.token, 'plain-token');
  assert.equal(created.url, 'http://localhost:3000/dpagent-share/plain-token');
  assert.equal(agent.meta.sessionShare?.tokenHash.length, 64);
  assert.notEqual(agent.meta.sessionShare?.tokenHash, 'plain-token');
  assert.deepEqual(created.share, {
    active: true,
    createdAt: '2026-05-07T01:00:00.000Z',
    expiresAt: '2026-05-08T01:00:00.000Z',
    version: 1,
  });
  assert.deepEqual(service.resolveToken('plain-token'), {
    sessionId: 'sess-1',
    tokenHash: agent.meta.sessionShare?.tokenHash,
    createdAt: '2026-05-07T01:00:00.000Z',
    expiresAt: '2026-05-08T01:00:00.000Z',
    version: 1,
  });
}

function testCreateReplacesExistingActiveToken(): void {
  const agent = createAgent();
  let token = 'first-token';
  const service = new SessionShareService({
    agent: agent as any,
    now: () => new Date('2026-05-07T02:00:00.000Z'),
    randomToken: () => token,
  });

  service.create('sess-1');
  token = 'second-token';
  const second = service.create('sess-1');

  assert.equal(second.token, 'second-token');
  assert.equal(second.share.version, 2);
  assert.equal(service.resolveToken('first-token'), null);
  assert.equal(service.resolveToken('second-token')?.version, 2);
}

function testCreateUsesDynamicTtl(): void {
  const agent = createAgent();
  let ttlMs = 2 * 60 * 60 * 1000;
  const service = new SessionShareService({
    agent: agent as any,
    now: () => new Date('2026-05-07T04:00:00.000Z'),
    randomToken: () => 'token',
    ttlMs: () => ttlMs,
  });

  const first = service.create('sess-1');
  ttlMs = 5 * 60 * 60 * 1000;
  const second = service.create('sess-1');

  assert.equal(first.share.expiresAt, '2026-05-07T06:00:00.000Z');
  assert.equal(second.share.expiresAt, '2026-05-07T09:00:00.000Z');
}

function testRevokeAndExpiryInvalidateToken(): void {
  const agent = createAgent();
  let now = new Date('2026-05-07T03:00:00.000Z');
  const service = new SessionShareService({
    agent: agent as any,
    now: () => now,
    randomToken: () => 'token',
  });

  service.create('sess-1');
  assert.ok(service.resolveToken('token'));
  service.revoke('sess-1');
  assert.equal(service.resolveToken('token'), null);

  service.create('sess-1');
  now = new Date('2026-05-08T03:00:01.000Z');
  assert.equal(service.getStatus('sess-1').active, false);
  assert.equal(service.resolveToken('token'), null);
}

function runAll(): void {
  testCreateStoresHashAndReturnsPlainTokenOnce();
  testCreateReplacesExistingActiveToken();
  testCreateUsesDynamicTtl();
  testRevokeAndExpiryInvalidateToken();
  console.log('session-share-service tests passed');
}

runAll();
