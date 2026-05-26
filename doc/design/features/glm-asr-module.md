# GLM ASR Module

## Current Scope

The ASR module provides local speech-to-text for voice input. Browser clients
record microphone audio in short chunks, stream those chunks to the DPAgent Web
server, and receive stable text fragments that are appended to the composer
draft. The transcript is not sent to the agent until the user presses Send.

The first supported model target is `zai-org/GLM-ASR-Nano-2512`. DPAgent invokes
the model through a local process adapter so the Node runtime does not take a
hard dependency on Python ML packages.

## Runtime Shape

The runtime module owns:

- ASR config normalization with disabled-by-default behavior.
- A persistent local ASR worker lifecycle with startup, ready, failed, and stop
  states.
- A stable `AsrService` transcription interface.
- Local audio file validation before model invocation.
- Local process spawning without shell interpolation.
- Timeout, max audio size, and max concurrency controls.
- Queue and stdout/stderr size limits.
- JSON or plain text result parsing.

The Web integration owns:

- `GET /api/asr/status` for public ASR capability discovery and worker state.
- `POST /api/sessions/:id/asr/transcribe` for raw audio upload and local
  transcription compatibility.
- WebSocket `asr_stream_*` messages for chunked recording, partial transcript
  delivery, cancellation, and completion.
- Composer recording state, streaming state, and transcript insertion.

The feature does not own:

- Durable session storage for raw audio or transcript drafts.
- Agent run submission.

## Local Model Command

Windows users can run the local setup helper from the project root:

```powershell
npm run setup:asr:windows
```

The helper creates or reuses `.venv-asr`, installs the Python ASR dependencies,
updates `config.yaml` to enable the local persistent worker, and starts the
worker once to verify that it reports ready. For scripting or CI smoke checks,
the helper also accepts `-SkipInstall` and `-SkipSmoke`.

The default command points to the optional local wrapper:

```yaml
asr:
  enabled: true
  provider: local-process
  command: .\.venv-asr\Scripts\python.exe
  args:
    - scripts/asr/glm-asr-transformers-worker.py
    - --model
    - "{modelId}"
  modelId: 'zai-org/GLM-ASR-Nano-2512'
  timeoutMs: 120000
  startupTimeoutMs: 180000
  restartBackoffMs: 3000
  maxConcurrent: 1
  maxQueueSize: 4
  maxAudioBytes: 26214400
  maxOutputBytes: 1048576
  resultFormat: json
```

Operators may replace the command with an SGLang client, a dedicated Python
virtualenv entrypoint, or another local wrapper as long as stdout follows the
persistent JSONL worker protocol:

- Emit `{"type":"ready"}` after the model is loaded.
- Read one JSON request per stdin line with `id`, `audioPath`, and optional
  `language`.
- Emit one JSON response per stdout line with the same `id` and either
  `result.text` or `error`.

An empty `result.text` is a successful "no speech recognized" result.

Remote browsers need `getUserMedia`, `AudioContext`, and a secure browser
context. `localhost` works for local testing; remote LAN clients normally need
HTTPS or an equivalent trusted tunnel before the browser will grant microphone
access.

The browser voice button is hidden unless ASR is configured, the backend worker
is ready, the WebSocket is connected, and the browser supports recording.

## Result Contract

JSON output should use this shape:

```json
{
  "text": "transcribed text",
  "language": "zh",
  "durationMs": 1234,
  "model": "zai-org/GLM-ASR-Nano-2512",
  "segments": [{ "startMs": 0, "endMs": 500, "text": "transcribed" }]
}
```

Only `text` is required. Segment entries without numeric `startMs`, numeric
`endMs`, and non-empty `text` are ignored. Empty `text` means no transcript is
inserted for that chunk.

## Acceptance

- Disabled ASR rejects transcription before touching the local process.
- Configured ASR starts a persistent worker at WebServer startup and reports
  readiness through `/api/asr/status`.
- WebSocket chunk streaming returns partial transcript messages as chunks are
  recognized.
- Missing, empty, non-file, or oversized audio files fail before model
  invocation.
- Local command arguments are expanded by token replacement, not shell string
  composition.
- A successful local command returns normalized text, model, language, duration,
  and optional segments.
- Shared-link access cannot call the session ASR route.
- Observe-only sessions reject transcription so Web cannot mutate an active
  CLI/automation-owned run.
- Raw audio temp files are removed after each transcription attempt.
