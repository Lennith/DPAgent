import * as assert from 'node:assert/strict';
import {
  DEFAULT_REMOTE_ACCESS_AUTH_CONFIG,
  createSessionCookie,
  getAuthStatus,
  isLoopbackRequest,
  isSameOriginRequest,
  setServerSecret,
  verifySessionCookie,
} from '../../src/web/server/remote-access-auth.js';

function mockRequest(remoteAddress: string, headers: Record<string, string> = {}) {
  return {
    socket: { remoteAddress },
    headers,
  } as never;
}

function testHostHeaderDoesNotCreateLoopbackBypass(): void {
  const req = mockRequest('10.0.0.12', { host: 'localhost:53721' });
  assert.equal(isLoopbackRequest(req, DEFAULT_REMOTE_ACCESS_AUTH_CONFIG), false);
}

function testSocketLoopbackStillBypasses(): void {
  const req = mockRequest('127.0.0.1', { host: 'example.test' });
  assert.equal(isLoopbackRequest(req, DEFAULT_REMOTE_ACCESS_AUTH_CONFIG), true);
}

function testTrustedProxyUsesForwardedClientFromLoopbackPeer(): void {
  const req = mockRequest('127.0.0.1', {
    'x-forwarded-for': '10.0.0.12',
  });

  assert.equal(isLoopbackRequest(req, DEFAULT_REMOTE_ACCESS_AUTH_CONFIG), true);
  assert.equal(
    isLoopbackRequest(req, {
      ...DEFAULT_REMOTE_ACCESS_AUTH_CONFIG,
      trustProxy: true,
    }),
    false
  );
}

function testTrustedProxyRejectsMixedForwardedForChain(): void {
  const prependedLoopbackReq = mockRequest('127.0.0.1', {
    'x-forwarded-for': '127.0.0.1, 10.0.0.12',
  });
  const appendedLoopbackReq = mockRequest('127.0.0.1', {
    'x-forwarded-for': '10.0.0.12, 127.0.0.1',
  });

  assert.equal(
    isLoopbackRequest(prependedLoopbackReq, {
      ...DEFAULT_REMOTE_ACCESS_AUTH_CONFIG,
      trustProxy: true,
    }),
    false
  );
  assert.equal(
    isLoopbackRequest(appendedLoopbackReq, {
      ...DEFAULT_REMOTE_ACCESS_AUTH_CONFIG,
      trustProxy: true,
    }),
    false
  );
}

function testTrustedProxyRequiresForwardedIdentityFromLoopbackPeer(): void {
  const missingHeadersReq = mockRequest('127.0.0.1');
  const blankHeadersReq = mockRequest('127.0.0.1', {
    'x-forwarded-for': ' , ',
    'x-real-ip': '',
  });

  assert.equal(
    isLoopbackRequest(missingHeadersReq, {
      ...DEFAULT_REMOTE_ACCESS_AUTH_CONFIG,
      trustProxy: true,
    }),
    false
  );
  assert.equal(
    isLoopbackRequest(blankHeadersReq, {
      ...DEFAULT_REMOTE_ACCESS_AUTH_CONFIG,
      trustProxy: true,
    }),
    false
  );
}

function testTrustedProxyRejectsForwardedLoopbackFromLoopbackPeer(): void {
  const req = mockRequest('127.0.0.1', {
    'x-forwarded-for': '127.0.0.1',
  });

  assert.equal(
    isLoopbackRequest(req, {
      ...DEFAULT_REMOTE_ACCESS_AUTH_CONFIG,
      trustProxy: true,
    }),
    false
  );
}

function testTrustProxyIgnoresForwardedForFromPublicPeer(): void {
  const req = mockRequest('8.8.8.8', {
    'x-forwarded-for': '127.0.0.1',
  });

  assert.equal(
    isLoopbackRequest(req, {
      ...DEFAULT_REMOTE_ACCESS_AUTH_CONFIG,
      trustProxy: true,
    }),
    false
  );
}

function testTrustedProxyUsesRealIpOnlyToDetectRemoteClient(): void {
  const remoteReq = mockRequest('127.0.0.1', {
    'x-real-ip': '10.0.0.12',
  });
  const spoofedLocalReq = mockRequest('127.0.0.1', {
    'x-real-ip': '127.0.0.1',
  });

  assert.equal(
    isLoopbackRequest(remoteReq, {
      ...DEFAULT_REMOTE_ACCESS_AUTH_CONFIG,
      trustProxy: true,
    }),
    false
  );
  assert.equal(
    isLoopbackRequest(spoofedLocalReq, {
      ...DEFAULT_REMOTE_ACCESS_AUTH_CONFIG,
      trustProxy: true,
    }),
    false
  );
}

function testTrustedProxyRejectsConflictingForwardedHeaders(): void {
  const forwardedLocalRealRemoteReq = mockRequest('127.0.0.1', {
    'x-forwarded-for': '127.0.0.1',
    'x-real-ip': '10.0.0.12',
  });
  const forwardedRemoteRealLocalReq = mockRequest('127.0.0.1', {
    'x-forwarded-for': '10.0.0.12',
    'x-real-ip': '127.0.0.1',
  });

  assert.equal(
    isLoopbackRequest(forwardedLocalRealRemoteReq, {
      ...DEFAULT_REMOTE_ACCESS_AUTH_CONFIG,
      trustProxy: true,
    }),
    false
  );
  assert.equal(
    isLoopbackRequest(forwardedRemoteRealLocalReq, {
      ...DEFAULT_REMOTE_ACCESS_AUTH_CONFIG,
      trustProxy: true,
    }),
    false
  );
}

function testTrustProxyIgnoresForwardedHeadersFromPrivatePeers(): void {
  const privatePeers = ['10.0.0.5', '172.16.0.9', '172.31.255.1', '192.168.1.55', 'fd00::1'];
  for (const privatePeer of privatePeers) {
    const req = mockRequest(privatePeer, {
      'x-forwarded-for': '127.0.0.1',
      'x-real-ip': '127.0.0.1',
    });

    assert.equal(
      isLoopbackRequest(req, {
        ...DEFAULT_REMOTE_ACCESS_AUTH_CONFIG,
        trustProxy: true,
      }),
      false
    );
  }
}

function testTrustProxyIgnoresRealIpFromPublicPeer(): void {
  const req = mockRequest('8.8.8.8', {
    'x-real-ip': '127.0.0.1',
  });

  assert.equal(
    isLoopbackRequest(req, {
      ...DEFAULT_REMOTE_ACCESS_AUTH_CONFIG,
      trustProxy: true,
    }),
    false
  );
}

function testEnabledAuthWithoutCredentialsFailsClosed(): void {
  const status = getAuthStatus(mockRequest('10.0.0.12'), {
    ...DEFAULT_REMOTE_ACCESS_AUTH_CONFIG,
    enabled: true,
  });

  assert.equal(status.required, true);
  assert.equal(status.authenticated, false);
  assert.equal(status.configured, false);
}

function testSameOriginAllowsMissingOriginAndMatchingHost(): void {
  assert.equal(isSameOriginRequest(mockRequest('127.0.0.1', { host: '127.0.0.1:53721' })), true);
  assert.equal(
    isSameOriginRequest(
      mockRequest('127.0.0.1', {
        host: '127.0.0.1:53721',
        origin: 'http://127.0.0.1:53721',
      })
    ),
    true
  );
}

function testSameOriginRejectsCrossOriginBrowserWebSocket(): void {
  assert.equal(
    isSameOriginRequest(
      mockRequest('127.0.0.1', {
        host: '127.0.0.1:53721',
        origin: 'https://evil.example',
      })
    ),
    false
  );
}

function testSessionCookieTtlIsEnforced(): void {
  setServerSecret(Buffer.alloc(32, 1));
  const issuedAt = 1_000_000;
  const cookie = createSessionCookie(issuedAt);

  assert.equal(verifySessionCookie(cookie, 1_000, issuedAt + 999), true);
  assert.equal(verifySessionCookie(cookie, 1_000, issuedAt + 1_001), false);
}

function run(): void {
  testHostHeaderDoesNotCreateLoopbackBypass();
  testSocketLoopbackStillBypasses();
  testTrustedProxyUsesForwardedClientFromLoopbackPeer();
  testTrustedProxyRejectsMixedForwardedForChain();
  testTrustedProxyRequiresForwardedIdentityFromLoopbackPeer();
  testTrustedProxyRejectsForwardedLoopbackFromLoopbackPeer();
  testTrustedProxyUsesRealIpOnlyToDetectRemoteClient();
  testTrustedProxyRejectsConflictingForwardedHeaders();
  testTrustProxyIgnoresForwardedForFromPublicPeer();
  testTrustProxyIgnoresForwardedHeadersFromPrivatePeers();
  testTrustProxyIgnoresRealIpFromPublicPeer();
  testEnabledAuthWithoutCredentialsFailsClosed();
  testSameOriginAllowsMissingOriginAndMatchingHost();
  testSameOriginRejectsCrossOriginBrowserWebSocket();
  testSessionCookieTtlIsEnforced();
}

run();
