import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { JsonStateStore, createStateId, readJsonStateFile, writeJsonStateFile } from '../../src/storage/index.js';

interface StateShape {
  version: 1;
  items: string[];
}

function isStateShape(value: unknown): value is StateShape {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const parsed = value as Partial<StateShape>;
  return parsed.version === 1 && Array.isArray(parsed.items);
}

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'json-state-store-'));
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function testCorruptStateResetsWhenConfigured(): void {
  const dir = createTempDir();
  try {
    const filePath = path.join(dir, 'state.json');
    fs.writeFileSync(filePath, '{bad json', 'utf-8');
    const store = new JsonStateStore<StateShape>(filePath, {
      defaultValue: () => ({ version: 1, items: [] }),
      validate: isStateShape,
      parseErrorPolicy: 'reset',
    });
    assert.deepEqual(store.read(), { version: 1, items: [] });
    assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf-8')), { version: 1, items: [] });
  } finally {
    cleanup(dir);
  }
}

function testAtomicWriteRemovesTempFiles(): void {
  const dir = createTempDir();
  try {
    const filePath = path.join(dir, 'state.json');
    writeJsonStateFile(filePath, { ok: true });
    assert.deepEqual(readJsonStateFile(filePath, { ok: false }), { ok: true });
    assert.deepEqual(
      fs.readdirSync(dir).filter((name) => name.includes('.tmp')),
      []
    );
  } finally {
    cleanup(dir);
  }
}

function testCreateStateIdUsesPrefix(): void {
  assert.match(createStateId('run'), /^run-\d+-[a-f0-9]{8}$/);
}

function runAll(): void {
  testCorruptStateResetsWhenConfigured();
  testAtomicWriteRemovesTempFiles();
  testCreateStateIdUsesPrefix();
  console.log('json-state-store tests passed');
}

runAll();
