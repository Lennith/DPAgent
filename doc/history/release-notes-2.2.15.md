# DPAgent Release Notes: 2.2.15

## Highlights

- Add a provider vendor dialect layer for protocol-specific LLM behavior without spreading supplier branches through the adapters.
- Support Xiaomi MiMo thinking replay on the Anthropic protocol by allowing unsigned historical thinking blocks only for MiMo endpoints/models.
- Support Xiaomi MiMo OpenAI-compatible reasoning behavior with `thinking: { type: 'enabled' }` requests and historical `reasoning_content` replay.
- Keep standard Anthropic signed-thinking replay semantics unchanged, and keep DeepSeek reasoning replay isolated to DeepSeek-compatible behavior.
- Harden endpoint host matching so official MiniMax gateway routing, Xiaomi domains, Anthropic domains, and DeepSeek domains do not bleed into each other.
- Add Xiaomi MiMo to the maintained release toolcall context gate matrix.

## Verification Scope

- Added unit coverage for vendor dialect resolution, host matching, Anthropic thinking replay, and OpenAI-compatible reasoning replay.
- Verified real Xiaomi MiMo Anthropic and OpenAI-compatible two-turn thinking behavior; the follow-up turn referenced prior reasoning instead of restarting the same thinking path.
- Verified `deepseek`, `minimax`, and `xiaomi` release toolcall profiles at 10/10 each on the final commit.
- Verified `npm test`, `npm run build`, `npm run build:web`, `npm run smoke:ui:built`, and `npm run test:release-e2e`.
- Verified official npm publish dry-run packaging; actual publish was deferred from the current network.
