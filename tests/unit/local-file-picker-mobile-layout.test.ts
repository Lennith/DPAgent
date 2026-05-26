import * as assert from 'node:assert/strict';
import fs from 'fs';
import { createRequire } from 'node:module';
import path from 'path';
import { fileURLToPath } from 'url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider, LOCALE_STORAGE_KEY } from '../../src/web/client/i18n/index.js';
import { ThemeProvider } from '../../src/web/client/components/providers/ThemeProvider.js';

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

Object.defineProperty(globalThis, 'document', {
  value: { body: { nodeType: 1 } },
  configurable: true,
});

const require = createRequire(import.meta.url);
const reactDom = require('react-dom') as { createPortal: (node: React.ReactNode) => React.ReactNode };
reactDom.createPortal = (node: React.ReactNode) => node;

async function loadLocalFilePickerModal(): Promise<React.ComponentType<any>> {
  const module = await import('../../src/web/client/components/common/LocalFilePickerModal.js') as any;
  return module.LocalFilePickerModal ?? module.default?.LocalFilePickerModal;
}

function renderWithProviders(element: React.ReactElement): string {
  localStorage.setItem(LOCALE_STORAGE_KEY, 'en-US');
  return renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ThemeProvider, null, element)
    )
  );
}

function readLocalFilePickerSource(): string {
  const testDir = path.dirname(fileURLToPath(import.meta.url));
  return fs.readFileSync(
    path.resolve(testDir, '../../src/web/client/components/common/LocalFilePickerModal.tsx'),
    'utf8'
  );
}

async function testMobileLayoutKeepsDesktopColumnsUntouched(): Promise<void> {
  const LocalFilePickerModal = await loadLocalFilePickerModal();
  const html = renderWithProviders(
    React.createElement(LocalFilePickerModal, {
      isOpen: true,
      mode: 'file',
      title: 'Pick file',
      confirmLabel: 'Choose',
      selectedPaths: ['D:/workspace/report.md'],
      onConfirm: () => undefined,
      onClose: () => undefined,
    })
  );

  assert.match(html, /grid-cols-\[180px_minmax\(0,1fr\)\]/);
  assert.match(html, /max-\[520px\]:grid-cols-\[92px_minmax\(0,1fr\)\]/);
  assert.match(html, /max-\[520px\]:p-3/);
}

function testMobileLayoutLetsFilePaneKeepUsefulWidth(): void {
  const source = readLocalFilePickerSource();

  assert.match(source, /filesPane: 'min-h-0 min-w-0 overflow-hidden/);
  assert.match(source, /entryButton:\s*\n\s*'mb-1 grid w-full grid-cols-\[24px_minmax\(0,1fr\)_auto\]/);
  assert.match(source, /max-\[520px\]:grid-cols-\[20px_minmax\(0,1fr\)\]/);
  assert.match(source, /entryType: 'text-\[10px\] max-\[520px\]:hidden'/);
}

async function runAll(): Promise<void> {
  await testMobileLayoutKeepsDesktopColumnsUntouched();
  testMobileLayoutLetsFilePaneKeepUsefulWidth();
  console.log('local-file-picker-mobile-layout tests passed');
}

runAll().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
