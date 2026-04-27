import * as assert from 'node:assert/strict';
import {
  DEFAULT_WORKSPACE_STORAGE_KEY,
  loadDefaultWorkspaceFromStorage,
  normalizeWorkspaceDir,
  resolveDefaultWorkspaceDir,
  saveDefaultWorkspaceToStorage,
} from '../../src/web/client/workspace-preferences.js';

class MemoryStorageStub {
  private readonly store = new Map<string, string>();

  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key) ?? null : null;
  }

  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }
}

Object.defineProperty(globalThis, 'localStorage', {
  value: new MemoryStorageStub(),
  configurable: true,
});

function testNormalizeWorkspaceDir(): void {
  assert.equal(normalizeWorkspaceDir('  ./workspace  '), './workspace');
  assert.equal(normalizeWorkspaceDir(''), null);
  assert.equal(normalizeWorkspaceDir('   '), null);
  assert.equal(normalizeWorkspaceDir(undefined), null);
}

function testLoadDefaultWorkspaceWhenEmpty(): void {
  localStorage.removeItem(DEFAULT_WORKSPACE_STORAGE_KEY);
  assert.equal(loadDefaultWorkspaceFromStorage(), null);
}

function testSaveAndLoadDefaultWorkspace(): void {
  saveDefaultWorkspaceToStorage('  D:\\repo\\ws  ');
  assert.equal(loadDefaultWorkspaceFromStorage(), 'D:\\repo\\ws');
}

function testSaveInvalidWorkspaceRemovesValue(): void {
  saveDefaultWorkspaceToStorage('D:\\repo\\ws');
  assert.equal(loadDefaultWorkspaceFromStorage(), 'D:\\repo\\ws');
  saveDefaultWorkspaceToStorage('   ');
  assert.equal(loadDefaultWorkspaceFromStorage(), null);
}

function testResolveDefaultWorkspacePriority(): void {
  assert.equal(
    resolveDefaultWorkspaceDir({
      storedWorkspaceDir: 'D:\\stored',
      configuredWorkspaceDir: 'D:\\configured',
      fallbackWorkspaceDir: './workspace',
    }),
    'D:\\stored'
  );
  assert.equal(
    resolveDefaultWorkspaceDir({
      storedWorkspaceDir: '   ',
      configuredWorkspaceDir: 'D:\\configured',
      fallbackWorkspaceDir: './workspace',
    }),
    'D:\\configured'
  );
  assert.equal(
    resolveDefaultWorkspaceDir({
      storedWorkspaceDir: '   ',
      configuredWorkspaceDir: '   ',
      fallbackWorkspaceDir: './workspace',
    }),
    './workspace'
  );
}

function runAll(): void {
  testNormalizeWorkspaceDir();
  testLoadDefaultWorkspaceWhenEmpty();
  testSaveAndLoadDefaultWorkspace();
  testSaveInvalidWorkspaceRemovesValue();
  testResolveDefaultWorkspacePriority();
  console.log('workspace-preferences tests passed');
}

runAll();
