import * as assert from 'node:assert/strict';
import path from 'node:path';
import {
  coerceShellTypeForPlatform,
  getDefaultShellType,
  getRuntimePlatformCapabilities,
  getSupportedShellTypes,
  isShellSupportedOnPlatform,
} from '../../src/runtime-platform.js';

function testUnknownPlatformFallsBackToLinux(): void {
  const capabilities = getRuntimePlatformCapabilities('freebsd', {});
  assert.equal(capabilities.platform, 'linux');
  assert.equal(capabilities.label, 'Linux');
  assert.equal(capabilities.isUnixLike, true);
  assert.equal(capabilities.macosUntested, false);
  assert.deepEqual(capabilities.supportedShells, ['bash', 'sh']);
  assert.equal(capabilities.defaultShell, 'bash');
  assert.equal(capabilities.codexCliCommandDefault, 'codex');
  assert.equal(capabilities.traeCliCommandDefault, 'trae');
  assert.match(capabilities.promptBaseline, /Linux environment/);
  assert.match(capabilities.agentWorkspaceGuide, /YOUR RUNTIME IS LINUX/);
}

function testWindowsCapabilitiesUseAppDataCliPaths(): void {
  const appData = 'C:\\Users\\dev\\AppData\\Roaming';
  const capabilities = getRuntimePlatformCapabilities('win32', {
    APPDATA: appData,
  } as NodeJS.ProcessEnv);
  assert.equal(capabilities.platform, 'win32');
  assert.equal(capabilities.label, 'Windows');
  assert.equal(capabilities.isUnixLike, false);
  assert.equal(capabilities.macosUntested, false);
  assert.deepEqual(capabilities.supportedShells, ['powershell', 'cmd']);
  assert.equal(capabilities.defaultShell, 'powershell');
  assert.equal(capabilities.codexCliCommandDefault, path.join(appData, 'npm', 'codex.cmd'));
  assert.equal(capabilities.traeCliCommandDefault, path.join(appData, 'npm', 'trae.cmd'));
  assert.match(capabilities.promptBaseline, /Windows environment/);
  assert.match(capabilities.agentWorkspaceGuide, /DO NOT USE BASH OR UNIX COMMANDS/);
}

function testDarwinIncludesCompatibilityNotice(): void {
  const capabilities = getRuntimePlatformCapabilities('darwin', {});
  assert.equal(capabilities.platform, 'darwin');
  assert.equal(capabilities.label, 'macOS');
  assert.equal(capabilities.isUnixLike, true);
  assert.equal(capabilities.macosUntested, true);
  assert.deepEqual(capabilities.supportedShells, ['bash', 'sh']);
  assert.equal(capabilities.defaultShell, 'bash');
  assert.match(capabilities.promptBaseline, /not yet fully validated/);
  assert.match(capabilities.agentWorkspaceGuide, /not fully validated/);
}

function testShellHelpers(): void {
  assert.deepEqual(getSupportedShellTypes('linux'), ['bash', 'sh']);
  assert.deepEqual(getSupportedShellTypes('win32'), ['powershell', 'cmd']);
  assert.equal(getDefaultShellType('linux'), 'bash');
  assert.equal(getDefaultShellType('win32'), 'powershell');

  assert.equal(isShellSupportedOnPlatform('bash', 'linux'), true);
  assert.equal(isShellSupportedOnPlatform('powershell', 'linux'), false);
  assert.equal(isShellSupportedOnPlatform('cmd', 'win32'), true);

  assert.equal(coerceShellTypeForPlatform('bash', 'win32'), 'powershell');
  assert.equal(coerceShellTypeForPlatform('powershell', 'win32'), 'powershell');
  assert.equal(coerceShellTypeForPlatform(undefined, 'linux'), 'bash');
}

function runAll(): void {
  testUnknownPlatformFallsBackToLinux();
  testWindowsCapabilitiesUseAppDataCliPaths();
  testDarwinIncludesCompatibilityNotice();
  testShellHelpers();
  console.log('runtime-platform tests passed');
}

runAll();
