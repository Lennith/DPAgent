import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ContextUsageCalibrationStore } from '../../src/runtime/context-usage-calibration-store.js';

function withStore(testName: string, fn: (store: ContextUsageCalibrationStore, tempDir: string) => void): void {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `context-usage-calibration-${testName}-`));
  try {
    fn(new ContextUsageCalibrationStore(tempDir), tempDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function testDefaultsToOneWithoutSamples(): void {
  withStore('default', (store) => {
    assert.equal(
      store.getMultiplier({
        adapterProvider: 'anthropic',
        apiBase: 'https://api.minimaxi.com',
        model: 'MiniMax-M2.7',
      }),
      1
    );
  });
}

function testUsesMaxForSmallSampleSets(): void {
  withStore('max', (store) => {
    store.recordObservation({
      adapterProvider: 'anthropic',
      apiBase: 'https://api.minimaxi.com',
      model: 'MiniMax-M2.7',
      weightedTokens: 100,
      promptTokens: 150,
    });
    store.recordObservation({
      adapterProvider: 'anthropic',
      apiBase: 'https://api.minimaxi.com',
      model: 'MiniMax-M2.7',
      weightedTokens: 100,
      promptTokens: 120,
    });
    assert.equal(
      store.getMultiplier({
        adapterProvider: 'anthropic',
        apiBase: 'https://api.minimaxi.com',
        model: 'MiniMax-M2.7',
      }),
      1.5
    );
  });
}

function testSeparatesProtocolStacksByHostAndProvider(): void {
  withStore('keys', (store) => {
    store.recordObservation({
      adapterProvider: 'anthropic',
      apiBase: 'https://api.minimaxi.com',
      model: 'shared-model',
      weightedTokens: 100,
      promptTokens: 160,
    });
    store.recordObservation({
      adapterProvider: 'openai',
      apiBase: 'https://api.minimaxi.com/v1',
      model: 'shared-model',
      weightedTokens: 100,
      promptTokens: 130,
    });
    assert.equal(
      store.getMultiplier({
        adapterProvider: 'anthropic',
        apiBase: 'https://api.minimaxi.com',
        model: 'shared-model',
      }),
      1.6
    );
    assert.equal(
      store.getMultiplier({
        adapterProvider: 'openai',
        apiBase: 'https://api.minimaxi.com/v1',
        model: 'shared-model',
      }),
      1.3
    );
  });
}

function testUsesP90AfterEnoughSamples(): void {
  withStore('p90', (store) => {
    const ratios = [1.1, 1.2, 1.3, 1.4, 1.5, 1.6];
    for (const ratio of ratios) {
      store.recordObservation({
        adapterProvider: 'anthropic',
        apiBase: 'https://api.minimaxi.com',
        model: 'MiniMax-M2.7',
        weightedTokens: 100,
        promptTokens: ratio * 100,
      });
    }
    assert.equal(
      store.getMultiplier({
        adapterProvider: 'anthropic',
        apiBase: 'https://api.minimaxi.com',
        model: 'MiniMax-M2.7',
      }),
      1.6
    );
  });
}

testDefaultsToOneWithoutSamples();
testUsesMaxForSmallSampleSets();
testSeparatesProtocolStacksByHostAndProvider();
testUsesP90AfterEnoughSamples();
console.log('context-usage-calibration-store tests passed');
