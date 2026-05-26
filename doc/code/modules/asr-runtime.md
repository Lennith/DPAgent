# ASR Runtime

## Responsibility

The ASR runtime owns local speech-to-text service boundaries. It validates audio
files, normalizes ASR configuration, manages a persistent local model worker,
invokes transcription requests, and parses transcription results.

It does not own agent run submission, WebSocket events, or durable transcript
storage.

## Source Paths

- `src/asr/`: ASR service interfaces, GLM defaults, local process adapter, and
  persistent worker adapter.
- `src/web/server/web-server-asr-routes.ts`: ASR status and transcription
  routes.
- `src/web/server/web-server-asr-runtime.ts`: WebServer-owned ASR lifecycle.
- `src/web/server/web-server-asr-stream.ts`: WebSocket chunk streaming
  controller.
- `src/web/client/components/chat/useVoiceInput.ts`: browser recording and
  composer insertion hook.
- `src/web/client/asr-api.ts`: client ASR status request.
- `scripts/asr/`: optional local model wrapper scripts.
- `tests/unit/asr-local-process.test.ts`: closest unit coverage.
- `tests/unit/web-asr-routes.test.ts`: Web route coverage.

## Key Files

- `src/asr/types.ts`: service, input, result, config, and error contracts.
- `src/asr/glm-asr-config.ts`: GLM ASR default model and config normalization.
- `src/asr/local-process-asr.ts`: local process implementation with validation,
  concurrency, timeout, and stdout parsing.
- `src/asr/persistent-local-process-asr.ts`: persistent JSONL worker service.
- `scripts/asr/glm-asr-transformers.py`: optional one-shot GLM-ASR
  Transformers runner.
- `scripts/asr/glm-asr-transformers-worker.py`: persistent GLM-ASR
  Transformers JSONL worker.

## Runtime Data Or Contracts

The local process adapter expects an existing audio file path. It never writes
audio files itself; Web transport owns upload temp-file lifecycle before calling
this module.

The Web route writes request audio under `runtime/asr`, invokes the configured
local service, and removes the temp directory after the request completes. The
streaming controller writes chunk audio under `runtime/asr-stream`, invokes the
persistent worker per chunk, emits `asr_stream_partial` for recognized text and
for final empty-text commits, and removes stream temp files on stop, cancel, or
socket detach.

The default model id is `zai-org/GLM-ASR-Nano-2512`. Operators may override the
command and args as long as the local process follows the persistent JSONL
worker protocol. Empty `text` is allowed and means no transcript was recognized
for that audio chunk.

Windows local deployment is bootstrapped by
`npm run setup:asr:windows`. The script creates `.venv-asr`, installs the GLM
ASR Python runtime, writes the local-process ASR block into `config.yaml`, and
runs a worker readiness smoke test unless `-SkipSmoke` is provided.

## Edit Guidance

- Keep model-specific Python and ML dependency assumptions outside the Node
  runtime.
- Add new model backends as adapters rather than expanding route or UI code.
- Keep ASR routes out of shared-link scope unless a future product decision
  explicitly allows shared users to upload microphone audio.
- Preserve shell-free process spawning and tokenized arg expansion.
- Keep WebSocket stream messages session-scoped and rejected in observe-only
  mode.

## Closest Tests

- `npm run test:unit -- --grep asr-local-process`
- `npm run test:unit -- --grep web-asr-routes`
- `npm run test:unit -- --grep web-asr-stream`
- `npm run test:unit -- --grep voice-input-transcript`
- `tsx tests/unit/asr-local-process.test.ts`
- `tsx tests/unit/web-asr-routes.test.ts`
- `tsx tests/unit/web-asr-stream.test.ts`
