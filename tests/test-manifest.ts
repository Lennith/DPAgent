export type TestSuiteName = 'unit' | 'integration' | 'e2e' | 'contracts' | 'all';

export interface TestManifestEntry {
  id: string;
  suite: Exclude<TestSuiteName, 'contracts' | 'all'>;
  command: string;
  files: string[];
  tags: string[];
  timeoutMs?: number;
}

const UNIT_TEST_FILES = [
  'tests/unit/agent-finish-reason-gating.test.ts',
  'tests/unit/agent-context-usage-anchor.test.ts',
  'tests/unit/agent-cancel-signal.test.ts',
  'tests/unit/agent-hook-modified.test.ts',
  'tests/unit/agent-mention-share-token.test.ts',
  'tests/unit/agent-profiles.test.ts',
  'tests/unit/arena-routes.test.ts',
  'tests/unit/arena-store.test.ts',
  'tests/unit/arena-submit-tool.test.ts',
  'tests/unit/arena-workspace.test.ts',
  'tests/unit/web-arena-ui.test.ts',
  'tests/unit/asr-local-process.test.ts',
  'tests/unit/auto-generated-skill-governance.test.ts',
  'tests/unit/auto-loop-exit-tool.test.ts',
  'tests/unit/automation-run-coordinator.test.ts',
  'tests/unit/automation-schedule.test.ts',
  'tests/unit/automation-store.test.ts',
  'tests/unit/capability-catalog.test.ts',
  'tests/unit/chat-file-reference-prompt.test.ts',
  'tests/unit/chat-input-interactivity.test.ts',
  'tests/unit/chat-input-drag-path-utils.test.ts',
  'tests/unit/chat-input-drop-detection.test.ts',
  'tests/unit/composer-input-state.test.ts',
  'tests/unit/chat-scroll-policy.test.ts',
  'tests/unit/config-modal-drafts.test.ts',
  'tests/unit/compression-chunks.test.ts',
  'tests/unit/compressed-history-context-cache.test.ts',
  'tests/unit/context-history-replay.test.ts',
  'tests/unit/context-token-estimation.test.ts',
  'tests/unit/context-usage-calibration-store.test.ts',
  'tests/unit/context-manage-tool.test.ts',
  'tests/unit/context-overflow-recovery.test.ts',
  'tests/unit/context-payload-projector.test.ts',
  'tests/unit/context-reduction-policy.test.ts',
  'tests/unit/context-run-concurrency.test.ts',
  'tests/unit/context-window-budget-anchor.test.ts',
  'tests/unit/dpagent-runtime-support.test.ts',
  'tests/unit/dpagent-exec-cli.test.ts',
  'tests/unit/dpagent-assistant-skills-cli.test.ts',
  'tests/unit/dpagent-share-client-skill.test.ts',
  'tests/unit/eval-toolcall-context-session.test.ts',
  'tests/unit/execution-tool-registry-gating.test.ts',
  'tests/unit/hook-registry.test.ts',
  'tests/unit/hook-runner.test.ts',
  'tests/unit/governance-audit-store.test.ts',
  'tests/unit/governance-tool-audit.test.ts',
  'tests/unit/in-memory-lock.test.ts',
  'tests/unit/json-state-store.test.ts',
  'tests/unit/local-file-browser.test.ts',
  'tests/unit/llm-anthropic-tool-protocol.test.ts',
  'tests/unit/llm-openai-compatible.test.ts',
  'tests/unit/llm-provider-payload-preparation.test.ts',
  'tests/unit/llm-provider-profiles.test.ts',
  'tests/unit/llm-provider-routing.test.ts',
  'tests/unit/llm-provider-runtime-contracts.test.ts',
  'tests/unit/llm-session-state.test.ts',
  'tests/unit/llm-thinking-signature.test.ts',
  'tests/unit/llm-vendor-dialects.test.ts',
  'tests/unit/local-file-picker-mobile-layout.test.ts',
  'tests/unit/markdown-rendering.test.ts',
  'tests/unit/mcp-connector-reconnect.test.ts',
  'tests/unit/mcp-runtime-config.test.ts',
  'tests/unit/mcp-shared-runtime.test.ts',
  'tests/unit/mcp-status-ui.test.ts',
  'tests/unit/memory-promotion-coordinator.test.ts',
  'tests/unit/memory-store.test.ts',
  'tests/unit/minimax-openai-provider-run.test.ts',
  'tests/unit/npm-official-publish.test.ts',
  'tests/unit/permission-manager.test.ts',
  'tests/unit/package-release-sanitized-config.test.ts',
  'tests/unit/plan-mode-agent-case.test.ts',
  'tests/unit/plan-mode-tools.test.ts',
  'tests/unit/profile-introspection-service.test.ts',
  'tests/unit/read-file-tool.test.ts',
  'tests/unit/release-toolcall-context-gate.test.ts',
  'tests/unit/release-source-contract-smoke.test.ts',
  'tests/unit/remote-access-auth.test.ts',
  'tests/unit/running-input-queue-coordinator.test.ts',
  'tests/unit/runtime-async-primitives.test.ts',
  'tests/unit/runtime-platform.test.ts',
  'tests/unit/session-controller-hydration.test.ts',
  'tests/unit/session-controller-message-builders.test.ts',
  'tests/unit/session-controller-runtime-events.test.ts',
  'tests/unit/session-controller-view-state.test.ts',
  'tests/unit/send-file-to-user-tool.test.ts',
  'tests/unit/session-share-service.test.ts',
  'tests/unit/share-copy-feedback.test.ts',
  'tests/unit/session-llm-popover-position.test.ts',
  'tests/unit/shell-tool.test.ts',
  'tests/unit/slim-refactor-contract-manifest.test.ts',
  'tests/unit/skill-write-store-auto.test.ts',
  'tests/unit/skill-loader-precedence.test.ts',
  'tests/unit/skill-loader-progressive.test.ts',
  'tests/unit/skill-pack-store.test.ts',
  'tests/unit/skill.test.ts',
  'tests/unit/subagent-lifecycle-reducer.test.ts',
  'tests/unit/subagent-manage-tool.test.ts',
  'tests/unit/subagent-manager.test.ts',
  'tests/unit/subagent-runner-agent-profile.test.ts',
  'tests/unit/test-manifest-runner-timeout.test.ts',
  'tests/unit/todo-store.test.ts',
  'tests/unit/tool-event-summary.test.ts',
  'tests/unit/tool-registration-dedupe.test.ts',
  'tests/unit/tool-result-payload-policy.test.ts',
  'tests/unit/toolset-registry.test.ts',
  'tests/unit/turn-recovery-policy.test.ts',
  'tests/unit/turn-summary-v2.test.ts',
  'tests/unit/ux-iterate-config-protection.test.ts',
  'tests/unit/web-auto-loop-exit-callback.test.ts',
  'tests/unit/web-asr-routes.test.ts',
  'tests/unit/web-asr-stream.test.ts',
  'tests/unit/web-agent-authoring-routes.test.ts',
  'tests/unit/voice-input-transcript.test.ts',
  'tests/unit/web-automation-execution.test.ts',
  'tests/unit/web-automation-routes.test.ts',
  'tests/unit/web-automation-scheduler.test.ts',
  'tests/unit/web-callback-assembly.test.ts',
  'tests/unit/web-callback-completion.test.ts',
  'tests/unit/web-callback-event-dispatcher.test.ts',
  'tests/unit/web-callback-event-messages.test.ts',
  'tests/unit/web-cancel-message.test.ts',
  'tests/unit/web-chat-message.test.ts',
  'tests/unit/web-cli-continuation.test.ts',
  'tests/unit/web-cli-observe-ui.test.ts',
  'tests/unit/web-config-modal-ui.test.ts',
  'tests/unit/web-config-provider.test.ts',
  'tests/unit/web-default-mcp-config.test.ts',
  'tests/unit/web-download-attachment-ui.test.ts',
  'tests/unit/web-download-routes.test.ts',
  'tests/unit/web-dropped-file-upload-route.test.ts',
  'tests/unit/web-guide-routes.test.ts',
  'tests/unit/web-governance-routes.test.ts',
  'tests/unit/web-i18n.test.ts',
  'tests/unit/web-interrupted-artifact-ui.test.ts',
  'tests/unit/web-llm-profile-routes.test.ts',
  'tests/unit/web-mcp-status.test.ts',
  'tests/unit/web-memory-organize-route.test.ts',
  'tests/unit/web-memory-organize-ui.test.ts',
  'tests/unit/web-observe-only-routes.test.ts',
  'tests/unit/web-share-text-routes.test.ts',
  'tests/unit/web-workspace-governance-routes.test.ts',
  'tests/unit/web-plan-input-normalization.test.ts',
  'tests/unit/web-plan-input-response-messages.test.ts',
  'tests/unit/web-plan-input-response.test.ts',
  'tests/unit/web-port-config.test.ts',
  'tests/unit/web-prompt-resolution.test.ts',
  'tests/unit/web-request-user-input.test.ts',
  'tests/unit/web-runtime-watchdog.test.ts',
  'tests/unit/web-session-planning-state-route.test.ts',
  'tests/unit/web-session-download-tool.test.ts',
  'tests/unit/web-skill-routes.test.ts',
  'tests/unit/web-stop-auto-loop-message.test.ts',
  'tests/unit/web-tool-call-state.test.ts',
  'tests/unit/web-toolset-routes.test.ts',
  'tests/unit/web-wss-control.test.ts',
  'tests/unit/web-ws-message-dispatch.test.ts',
  'tests/unit/websocket-reconnect-send.test.ts',
  'tests/unit/websocket-reconnect-policy.test.ts',
  'tests/unit/workspace-modal-utils.test.ts',
  'tests/unit/workspace-preferences.test.ts',
] as const;

const INTEGRATION_TEST_FILES = [
  'tests/integration/compression.test.ts',
  'tests/integration/concurrent.test.ts',
  'tests/integration/mcp.test.ts',
  'tests/integration/migration.test.ts',
  'tests/integration/p0-session-transcript-search.test.ts',
  'tests/integration/p1-session-toolset-override.test.ts',
  'tests/integration/p2-governance-lifecycle.test.ts',
  'tests/integration/persistence.test.ts',
] as const;

const E2E_TEST_FILES = [
  'tests/e2e/dpagent-assistant-skills-runtime-agent.e2e.ts',
  'tests/e2e/plan-stop-switch-model.e2e.ts',
  'tests/e2e/release-agent-web-regression.e2e.ts',
  'tests/e2e/release-plan-mode-lifecycle.e2e.ts',
  'tests/e2e/release-plan-mode-ux.e2e.ts',
  'tests/e2e/schedule-task-cancel.e2e.ts',
  'tests/e2e/release-cli-long-session.e2e.ts',
  'tests/e2e/skill-governance.e2e.ts',
] as const;

export const REQUIRED_SLIM_REFACTOR_CONTRACT_TAGS = [
  'contract:auth-http',
  'contract:auth-ws',
  'contract:host-spoofing',
  'contract:config-root-merge',
  'contract:context-budget-canonical-config',
  'contract:capability-catalog',
  'contract:permission-matrix',
  'contract:json-store-corruption',
  'contract:json-store-atomic-write',
  'contract:subagent-lifecycle-matrix',
  'contract:automation-overlap',
  'contract:memory-promotion-parity',
] as const;

const CONTRACT_TAGS_BY_FILE: Record<string, string[]> = {
  "tests/unit/remote-access-auth.test.ts": [
    "contract:auth-http",
    "contract:auth-ws",
    "contract:host-spoofing",
    "contract:remote-auth-defaults"
  ],
  "tests/unit/web-config-provider.test.ts": [
    "contract:config-root-merge",
    "contract:config-rollback"
  ],
  "tests/unit/llm-provider-profiles.test.ts": [
    "contract:context-budget-canonical-config",
    "contract:context-budget-root-merge",
    "contract:context-budget-removed-field-rejection"
  ],
  "tests/unit/capability-catalog.test.ts": [
    "contract:capability-catalog"
  ],
  "tests/unit/permission-manager.test.ts": [
    "contract:permission-matrix"
  ],
  "tests/unit/shell-tool.test.ts": [
    "contract:permission-matrix"
  ],
  "tests/unit/read-file-tool.test.ts": [
    "contract:permission-matrix"
  ],
  "tests/unit/json-state-store.test.ts": [
    "contract:json-store-corruption",
    "contract:json-store-atomic-write"
  ],
  "tests/unit/subagent-lifecycle-reducer.test.ts": [
    "contract:subagent-lifecycle-matrix"
  ],
  "tests/unit/subagent-manager.test.ts": [
    "contract:subagent-lifecycle-matrix"
  ],
  "tests/unit/automation-run-coordinator.test.ts": [
    "contract:automation-overlap"
  ],
  "tests/unit/web-automation-scheduler.test.ts": [
    "contract:automation-overlap"
  ],
  "tests/unit/memory-store.test.ts": [
    "contract:memory-promotion-parity"
  ],
  "tests/unit/context-history-replay.test.ts": [
    "contract:replay-dead-code-boundary"
  ],
  "tests/unit/compressed-history-context-cache.test.ts": [
    "contract:compressed-history-cache"
  ],
  "tests/unit/compression-chunks.test.ts": [
    "contract:context-compression-chunks"
  ],
  "tests/unit/context-reduction-policy.test.ts": [
    "contract:context-reduction-policy"
  ],
  "tests/unit/tool-result-payload-policy.test.ts": [
    "contract:tool-result-payload-policy"
  ],
  "tests/unit/llm-provider-payload-preparation.test.ts": [
    "contract:provider-payload-boundary"
  ],
  "tests/integration/p0-session-transcript-search.test.ts": [
    "default-test"
  ],
  "tests/integration/p1-session-toolset-override.test.ts": [
    "default-test"
  ],
  "tests/integration/p2-governance-lifecycle.test.ts": [
    "default-test"
  ],
  "tests/e2e/release-agent-web-regression.e2e.ts": [
    "release-gate"
  ],
  "tests/e2e/release-plan-mode-lifecycle.e2e.ts": [
    "release-gate"
  ],
  "tests/e2e/release-plan-mode-ux.e2e.ts": [
    "release-gate"
  ],
  "tests/e2e/release-cli-long-session.e2e.ts": [
    "release-gate"
  ],
  "tests/e2e/schedule-task-cancel.e2e.ts": [
    "e2e"
  ]
};

function idFromFile(file: string): string {
  return file
    .replace(/^tests\/(unit|integration|e2e)\//, '')
    .replace(/\.(test|e2e)\.ts$/, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

function entryForFile(
  suite: Exclude<TestSuiteName, 'contracts' | 'all'>,
  file: string
): TestManifestEntry {
  return {
    id: `${suite}:${idFromFile(file)}`,
    suite,
    command: `tsx ${file}`,
    files: [file],
    tags: [suite, ...(CONTRACT_TAGS_BY_FILE[file] ?? [])],
  };
}

export const TEST_MANIFEST: TestManifestEntry[] = [
  ...UNIT_TEST_FILES.map((file) => entryForFile('unit', file)),
  ...INTEGRATION_TEST_FILES.map((file) => entryForFile('integration', file)),
  ...E2E_TEST_FILES.map((file) => entryForFile('e2e', file)),
];

export function getTestManifestEntries(suite: TestSuiteName): TestManifestEntry[] {
  if (suite === 'all') {
    return TEST_MANIFEST;
  }
  if (suite === 'contracts') {
    return TEST_MANIFEST.filter((entry) =>
      entry.tags.some((tag) => tag.startsWith('contract:'))
    );
  }
  return TEST_MANIFEST.filter((entry) => entry.suite === suite);
}
