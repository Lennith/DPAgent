import * as assert from 'node:assert/strict';
import { DEFAULT_WEB_PORT, resolveWebServerPort } from '../../src/web/server/port-config.js';

async function testResolveWebServerPortUsesDefaultWhenUnset(): Promise<void> {
  assert.equal(resolveWebServerPort(undefined), DEFAULT_WEB_PORT);
  assert.equal(resolveWebServerPort('   '), DEFAULT_WEB_PORT);
}

async function testResolveWebServerPortHonorsValidOverride(): Promise<void> {
  assert.equal(resolveWebServerPort('43001'), 43001);
  assert.equal(resolveWebServerPort(' 53722 '), 53722);
}

async function testResolveWebServerPortRejectsInvalidOverride(): Promise<void> {
  assert.throws(() => resolveWebServerPort('not-a-number'), /Invalid MINIMAX_PORT/);
  assert.throws(() => resolveWebServerPort('70000'), /Invalid MINIMAX_PORT/);
  assert.throws(() => resolveWebServerPort('123abc'), /Invalid MINIMAX_PORT/);
}

async function runAll(): Promise<void> {
  await testResolveWebServerPortUsesDefaultWhenUnset();
  await testResolveWebServerPortHonorsValidOverride();
  await testResolveWebServerPortRejectsInvalidOverride();
  console.log('web-port-config tests passed');
}

runAll().catch((error) => {
  console.error(error);
  process.exit(1);
});
