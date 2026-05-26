# LLM Runtime

## Responsibility
The LLM runtime adapts canonical prepared payloads into provider wire formats
and normalizes provider responses, streaming events, tool calls, finish reasons,
and usage.

## Source Paths
- `src/llm/`

## Key Files
- `src/llm/LLMClient.ts`: provider routing and runtime call boundary.
- `src/llm/tool-protocol.ts`: shared canonical tool protocol helpers.
- `src/llm/tool-protocol-analyzer.ts`: tool protocol validation and diagnostics.
- `src/llm/providers/AnthropicAdapter.ts`: Anthropic-compatible wire behavior.
- `src/llm/providers/OpenAICompatibleAdapter.ts`: OpenAI-compatible wire behavior.

## Runtime Contracts
Provider adapters are thin protocol adapters. They do not own context trimming,
Plan Mode, Todo continuation, or Agent recovery policy. OpenAI-compatible tool
arguments must be JSON objects before execution.

## Edit Guidance
- Add provider-specific behavior only at adapter boundaries.
- Keep canonical payload preparation shared.
- Reject malformed tool arguments; do not create fallback executable payloads.
- Update protocol tests when wire format or tool-call validation changes.

## Closest Tests
- `tests/unit/llm-provider-routing.test.ts`
- `tests/unit/llm-provider-payload-preparation.test.ts`
- `tests/unit/llm-provider-profiles.test.ts`
- `tests/unit/llm-provider-runtime-contracts.test.ts`
- `tests/unit/llm-anthropic-tool-protocol.test.ts`
- `tests/unit/llm-openai-compatible.test.ts`
- `tests/unit/minimax-openai-provider-run.test.ts`
- `tests/unit/llm-thinking-signature.test.ts`
