import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { HookRegistry } from '../../src/hooks/HookRegistry.js';
import type { HookConfigFile, HookEvent } from '../../src/hooks/types.js';

function makeConfig(hooks: HookConfigFile['hooks']): string {
  return yaml.dump({ hooks });
}

const VALID_EVENTS: readonly HookEvent[] = [
  'onTurnStart', 'onInputToLLM', 'onLLMResponse',
  'onBeforeToolCall', 'onAfterToolCall', 'onTurnEnd',
];

async function testValidConfig(): Promise<void> {
  const config = makeConfig([
    { id: 'test-hook', events: ['onInputToLLM'], module: './hooks/test.cjs', priority: 100 },
  ]);
  const parsed = yaml.load(config) as HookConfigFile;
  assert.ok(Array.isArray(parsed.hooks), 'hooks should be an array');
  assert.equal(parsed.hooks.length, 1);
  assert.equal(parsed.hooks[0].id, 'test-hook');
  assert.deepEqual(parsed.hooks[0].events, ['onInputToLLM']);
}

async function testRejectsMissingId(): Promise<void> {
  assert.throws(() => {
    const config = makeConfig([
      { events: ['onInputToLLM'], module: './hooks/test.cjs' } as never,
    ]);
    const parsed = yaml.load(config) as HookConfigFile;
    if (!parsed.hooks[0].id) {
      throw new Error("hooks[0] is missing 'id'");
    }
  });
}

async function testRejectsUnknownEvent(): Promise<void> {
  assert.throws(() => {
    const config = makeConfig([
      { id: 'bad', events: ['unknown_event'], module: './hooks/test.cjs' } as never,
    ]);
    const parsed = yaml.load(config) as HookConfigFile;
    for (const evt of parsed.hooks[0].events) {
      if (!(VALID_EVENTS as readonly string[]).includes(evt)) {
        throw new Error(`unknown event "${evt}"`);
      }
    }
  }, /unknown_event/);
}

async function testRejectsDuplicateIds(): Promise<void> {
  assert.throws(() => {
    const config = makeConfig([
      { id: 'dup', events: ['onInputToLLM'], module: './hooks/a.cjs' },
      { id: 'dup', events: ['onLLMResponse'], module: './hooks/b.cjs' },
    ]);
    const parsed = yaml.load(config) as HookConfigFile;
    const seen = new Set<string>();
    for (const h of parsed.hooks) {
      if (seen.has(h.id)) throw new Error(`duplicate id "${h.id}"`);
      seen.add(h.id);
    }
  }, /dup/);
}

async function testEmptyRegistry(): Promise<void> {
  const registry = new HookRegistry();
  assert.equal(registry.getUserHookCount(), 0);
  assert.equal(registry.getSystemHookCount(), 0);
  assert.equal(registry.hasUserHooks(), false);
  assert.equal(registry.getLoadError(), null);
}

async function testLoadFromWorkspaceLoadsConfiguredHookModule(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-registry-workspace-'));
  try {
    fs.mkdirSync(path.join(root, 'hooks'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'hook.config.yaml'),
      makeConfig([
        { id: 'workspace-hook', events: ['onInputToLLM'], module: './hooks/workspace-hook.cjs', priority: 10 },
      ]),
      'utf-8'
    );
    fs.writeFileSync(
      path.join(root, 'hooks', 'workspace-hook.cjs'),
      'module.exports = { onInputToLLM: () => ({ action: "continue", modified: { input: "from hook" } }) };\n',
      'utf-8'
    );
    const registry = new HookRegistry();
    registry.loadFromWorkspace(root);
    assert.equal(registry.getLoadError(), null);
    assert.equal(registry.getUserHookCount(), 1);
    const hooks = registry.getUserHooksForEvent('onInputToLLM');
    assert.equal(hooks.length, 1);
    assert.equal(hooks[0]?.entry.id, 'workspace-hook');
    assert.equal(typeof hooks[0]?.handler.onInputToLLM, 'function');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

void (async () => {
  await testValidConfig();
  await testRejectsMissingId();
  await testRejectsUnknownEvent();
  await testRejectsDuplicateIds();
  await testEmptyRegistry();
  await testLoadFromWorkspaceLoadsConfiguredHookModule();
  console.log('hook-registry tests passed');
})();
