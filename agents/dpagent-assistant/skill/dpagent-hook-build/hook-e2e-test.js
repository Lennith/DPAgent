/**
 * E2E Hook Test - 5 rounds using DPAgent directly with hooks enabled.
 *
 * Usage:
 *   node ./hook-e2e-test.js --root . --config config.yaml --workspace .tmp/hook-e2e
 *
 * Environment overrides:
 *   DPAGENT_E2E_ROOT, DPAGENT_E2E_CONFIG, DPAGENT_E2E_WORKSPACE
 */
const path = require('path');
const fs = require('fs');

function readArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function toYamlPath(value) {
  return path.resolve(value).replace(/\\/g, '/');
}

const DEFAULT_ROOT =
  path.basename(__dirname) === 'scripts'
    ? path.resolve(__dirname, '..')
    : path.resolve(__dirname, '..', '..');
const ROOT = path.resolve(process.env.DPAGENT_E2E_ROOT || readArg('--root') || DEFAULT_ROOT);
const CONFIG_PATH = path.resolve(
  process.env.DPAGENT_E2E_CONFIG || readArg('--config') || path.join(ROOT, 'config.yaml')
);
const WORKSPACE_DIR = path.resolve(
  process.env.DPAGENT_E2E_WORKSPACE || readArg('--workspace') || path.join(ROOT, '.tmp', 'hook-e2e')
);
const DEMO_PLUGIN = path.join(__dirname, 'examples', 'full-hook-demo.cjs');

process.env.DPAGENT_WORKSPACE_DIR = WORKSPACE_DIR;

async function main() {
  const distPath = path.join(ROOT, 'dist', 'index.js');
  if (!fs.existsSync(distPath)) {
    throw new Error('dist/index.js not found. Run npm run build before hook E2E.');
  }
  if (!fs.existsSync(DEMO_PLUGIN)) {
    throw new Error('Demo hook plugin not found: ' + DEMO_PLUGIN);
  }

  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
  fs.mkdirSync(path.join(WORKSPACE_DIR, 'logs'), { recursive: true });

  const logPath = path.join(WORKSPACE_DIR, 'logs', 'hook-demo', 'hook-demo.log');
  const fallbackPath = path.join(process.cwd(), 'logs', 'hook-demo', 'hook-demo.log');
  if (fs.existsSync(logPath)) fs.unlinkSync(logPath);
  if (fs.existsSync(fallbackPath)) fs.unlinkSync(fallbackPath);

  fs.writeFileSync(
    path.join(WORKSPACE_DIR, 'hook.config.yaml'),
    [
      'hooks:',
      '  - id: full-hook-demo',
      '    events: [onTurnStart,onInputToLLM,onLLMResponse,onBeforeToolCall,onAfterToolCall,onTurnEnd]',
      '    module: "' + toYamlPath(DEMO_PLUGIN) + '"',
      '    priority: 100',
      '    enabled: true',
      '',
    ].join('\n')
  );

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

  const namespace = 'sess-hook-e2e-' + Date.now();
  const prompts = [
    'Hello! Introduce yourself in one short sentence.',
    'What tools are available? Just list the names.',
    'Calculate 123 * 456.',
    'What time is it?',
    'Summarize our conversation in one sentence.',
  ];

  for (let i = 0; i < prompts.length; i += 1) {
    const prompt = prompts[i];
    console.log('\n=== Round ' + (i + 1) + '/5 ===');
    const result = await agent.runWithResult({
      prompt,
      context: { scope: 'session', namespace },
      workspaceDir: WORKSPACE_DIR,
    });
    console.log('  finishReason=' + result.finishReason + ' contentLen=' + (result.content?.length ?? 0));
  }

  const effectivePath = fs.existsSync(logPath) ? logPath : fallbackPath;
  if (!fs.existsSync(effectivePath)) {
    throw new Error('Hook log not found at ' + effectivePath);
  }

  const lines = fs.readFileSync(effectivePath, 'utf8').trim().split('\n').filter(Boolean);
  const counts = {};
  const events = new Set();
  for (const line of lines) {
    const event = JSON.parse(line);
    counts[event.event] = (counts[event.event] || 0) + 1;
    events.add(event.event);
  }

  console.log('\n[Hook Log] ' + lines.length + ' entries at ' + effectivePath);
  console.log('[Hook Log] Events seen: ' + [...events].sort().join(', '));
  console.log('[Hook Log] Counts:');
  for (const [event, count] of Object.entries(counts)) {
    console.log('  ' + event + ': ' + count);
  }

  const expected = ['onTurnStart', 'onInputToLLM', 'onLLMResponse', 'onBeforeToolCall', 'onAfterToolCall', 'onTurnEnd'];
  const missing = expected.filter((event) => !events.has(event));
  if (missing.length > 0) {
    throw new Error('Missing hook events: ' + missing.join(', '));
  }
  console.log('\n[PASS] All 6 hook events fired.');
}

main().catch((err) => {
  console.error('[FATAL]', err.message);
  process.exit(1);
});
