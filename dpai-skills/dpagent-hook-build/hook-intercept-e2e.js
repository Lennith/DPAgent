/**
 * E2E: Hook block-then-continue test.
 *
 * Usage:
 *   node ./hook-intercept-e2e.js --root . --config config.yaml --workspace .tmp/hook-intercept-e2e
 *
 * Environment overrides:
 *   DPAGENT_E2E_ROOT, DPAGENT_E2E_CONFIG, DPAGENT_E2E_WORKSPACE
 */
const path = require('path');
const fs = require('fs');
const yaml = require('js-yaml');

function readArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function toYamlPath(value) {
  return path.resolve(value).replace(/\\/g, '/');
}

const DEFAULT_ROOT = path.resolve(__dirname, '..', '..');
const ROOT = path.resolve(process.env.DPAGENT_E2E_ROOT || readArg('--root') || DEFAULT_ROOT);
const CONFIG_PATH = path.resolve(
  process.env.DPAGENT_E2E_CONFIG || readArg('--config') || path.join(ROOT, 'config.yaml')
);
const WORKSPACE_DIR = path.resolve(
  process.env.DPAGENT_E2E_WORKSPACE || readArg('--workspace') || path.join(ROOT, '.tmp', 'hook-intercept-e2e')
);
const CONTROL_FILE = path.join(WORKSPACE_DIR, 'e2e-intercept-control.json');
const INTERCEPT_LOG = path.join(WORKSPACE_DIR, 'logs', 'e2e-intercept.log');
const INTERCEPT_PLUGIN = path.join(__dirname, 'examples', 'e2e-intercept-test.cjs');
const DEMO_PLUGIN = path.join(__dirname, 'examples', 'full-hook-demo.cjs');

process.env.DPAGENT_WORKSPACE_DIR = WORKSPACE_DIR;
process.env.DPAGENT_HOOK_E2E_CONTROL_FILE = CONTROL_FILE;

function writeControl(obj) {
  fs.mkdirSync(path.dirname(CONTROL_FILE), { recursive: true });
  fs.writeFileSync(CONTROL_FILE, JSON.stringify(obj));
}

function clearControl() {
  try { fs.unlinkSync(CONTROL_FILE); } catch {}
  try { fs.unlinkSync(INTERCEPT_LOG); } catch {}
}

function writeHookConfig(modulePath, events) {
  const hookYaml = yaml.dump({
    hooks: [
      {
        id: 'e2e-intercept',
        events,
        module: toYamlPath(modulePath),
        priority: 1,
        enabled: true,
      },
    ],
  });
  fs.writeFileSync(path.join(WORKSPACE_DIR, 'hook.config.yaml'), hookYaml);
}

async function main() {
  const distPath = path.join(ROOT, 'dist', 'index.js');
  if (!fs.existsSync(distPath)) {
    throw new Error('dist/index.js not found. Run npm run build before hook E2E.');
  }
  if (!fs.existsSync(INTERCEPT_PLUGIN)) {
    throw new Error('Intercept hook plugin not found: ' + INTERCEPT_PLUGIN);
  }
  if (!fs.existsSync(DEMO_PLUGIN)) {
    throw new Error('Demo hook plugin not found: ' + DEMO_PLUGIN);
  }

  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
  fs.mkdirSync(path.join(WORKSPACE_DIR, 'logs'), { recursive: true });
  clearControl();
  writeHookConfig(INTERCEPT_PLUGIN, ['onInputToLLM', 'onBeforeToolCall', 'onAfterToolCall']);

  const { DPAgent } = require(distPath);

  console.log('[Test] Creating DPAgent...');
  const agent = new DPAgent({
    configPath: CONFIG_PATH,
    workspaceDir: WORKSPACE_DIR,
    runtimeDataDir: path.join(WORKSPACE_DIR, 'runtime'),
    contextDir: path.join(WORKSPACE_DIR, 'contexts'),
  });

  agent.initHooks(WORKSPACE_DIR);
  await agent.initialize();
  console.log('[Test] DPAgent initialized');

  const context = { scope: 'session', namespace: 'sess-hook-intercept-' + Date.now() };

  console.log('\n=== Phase 1: Normal (no block) ===');
  writeControl({ logPath: INTERCEPT_LOG });
  let result = await agent.runWithResult({ prompt: 'Say hello in one word.', context, workspaceDir: WORKSPACE_DIR });
  console.log('  result:', result.finishReason, result.content.slice(0, 80));
  if (result.finishReason !== 'end_turn') {
    throw new Error('Expected end_turn, got ' + result.finishReason);
  }

  console.log('\n=== Phase 2: Block onInputToLLM ===');
  writeControl({ blockInputToLLM: true, logPath: INTERCEPT_LOG });
  result = await agent.runWithResult({ prompt: 'This should be blocked.', context, workspaceDir: WORKSPACE_DIR });
  console.log('  result:', result.finishReason, result.content.slice(0, 80));
  if (result.finishReason !== 'hook_blocked') {
    throw new Error('Expected hook_blocked, got ' + result.finishReason);
  }
  if (!result.content.includes('blocked')) {
    throw new Error('Expected block message in content: ' + result.content);
  }

  console.log('\n=== Phase 3: Continue after block ===');
  writeControl({ logPath: INTERCEPT_LOG });
  result = await agent.runWithResult({ prompt: 'Say goodbye in one word.', context, workspaceDir: WORKSPACE_DIR });
  console.log('  result:', result.finishReason, result.content.slice(0, 80));
  if (result.finishReason !== 'end_turn') {
    throw new Error('Expected end_turn after recovery, got ' + result.finishReason);
  }

  console.log('\n=== Phase 4: Block onBeforeToolCall ===');
  writeControl({ blockToolCall: 'shell_execute', logPath: INTERCEPT_LOG });
  result = await agent.runWithResult({ prompt: 'Run shell_execute: echo test', context, workspaceDir: WORKSPACE_DIR });
  console.log('  result:', result.finishReason, result.content.slice(0, 120));

  console.log('\n=== Phase 5: Normal after tool block ===');
  writeControl({ logPath: INTERCEPT_LOG });
  result = await agent.runWithResult({ prompt: 'Say "done"', context, workspaceDir: WORKSPACE_DIR });
  console.log('  result:', result.finishReason, result.content.slice(0, 80));
  if (result.finishReason !== 'end_turn') {
    throw new Error('Expected end_turn, got ' + result.finishReason);
  }

  if (fs.existsSync(INTERCEPT_LOG)) {
    const lines = fs.readFileSync(INTERCEPT_LOG, 'utf8').trim().split('\n').filter(Boolean);
    const blockedLLM = lines.filter((line) => line.includes('"blockInputToLLM":true')).length;
    const blockedTool = lines.filter((line) => line.includes('"blockToolCall":')).length;
    console.log('\n[Intercept Log] ' + lines.length + ' entries, LLM blocks seen: ' + blockedLLM + ', tool blocks seen: ' + blockedTool);
  }

  clearControl();
  writeHookConfig(
    DEMO_PLUGIN,
    ['onTurnStart', 'onInputToLLM', 'onLLMResponse', 'onBeforeToolCall', 'onAfterToolCall', 'onTurnEnd']
  );
  console.log('\n[PASS] Hook intercept E2E complete');
}

main().catch((err) => {
  console.error('[FATAL]', err.message);
  clearControl();
  process.exit(1);
});
