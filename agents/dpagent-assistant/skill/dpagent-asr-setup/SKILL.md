---
name: dpagent-asr-setup
description: Configure GLM-ASR local speech-to-text for DPAgent. Use when the user asks to enable voice input, speech recognition, ASR, or microphone features in DPAgent.
---

# DPAgent ASR Setup

Configure local GLM-ASR speech-to-text so DPAgent's web client can accept
microphone voice input. The ASR runs locally via a Python worker process
using the `zai-org/GLM-ASR-Nano-2512` model.

This skill provides the setup guide. Runtime ASR scripts are installed in
`scripts/asr/` and are the paths written into `config.yaml`.

## Prerequisites Check

Before anything else, verify the environment:

```powershell
python --version
```

If Python is missing or < 3.10, tell the user to install Python 3.10+ from
https://www.python.org/downloads/ and ensure `python` is on PATH.

## Setup (Windows)

Run the one-click setup script from this skill directory:

```powershell
$skillDir = "skills/dpagent-asr-setup"
powershell -ExecutionPolicy Bypass -NoProfile -File $skillDir/setup-glm-asr.ps1 -ProjectRoot .
```

**What this does:**
1. Creates `.venv-asr/` with a fresh Python venv
2. Installs `torch`, `transformers`, `soundfile`, `numpy`
3. Downloads `zai-org/GLM-ASR-Nano-2512` from HuggingFace (~1.2 GB)
4. Smoke-tests the worker script with a short audio sample

Takes 5-15 minutes depending on network and disk speed.

If Python is already set up and model is downloaded:
```powershell
powershell -ExecutionPolicy Bypass -NoProfile -File skills/dpagent-asr-setup/setup-glm-asr.ps1 -ProjectRoot . -SkipInstall -SkipSmoke
```

## Configuration

After setup, ensure `config.yaml` has the ASR section enabled:

```yaml
asr:
  enabled: true
  provider: local-process
  command: .\.venv-asr\Scripts\python.exe
  args:
    - scripts/asr/glm-asr-transformers-worker.py
    - --model
    - "{modelId}"
  modelId: zai-org/GLM-ASR-Nano-2512
  timeoutMs: 120000
  startupTimeoutMs: 180000
  maxConcurrent: 1
  maxQueueSize: 4
  maxAudioBytes: 26214400
  maxOutputBytes: 1048576
  resultFormat: json
```

Key points:
- `enabled: true` — required to activate ASR
- `command` — points to the venv Python (`.\.venv-asr\Scripts\python.exe`)
- `args` — the worker script path relative to project root
- `modelId` — the HuggingFace model identifier

## Verification

After restarting DPAgent:

1. **Check status endpoint:**
   ```powershell
   curl http://localhost:53721/api/asr/status
   ```
   Expected: `"enabled": true`, worker state visible.

2. **Check the web client:** A microphone button appears in the chat input area.

3. **Check logs for errors:**
   Look for `[AsrService]` or `[PersistentLocalProcessAsr]` entries.
   Common issues:
   - `python not found` → check PATH
   - `model not found` → re-run setup script
   - `CUDA not available` → expected; GLM-ASR Nano runs on CPU

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Microphone button not showing | `asr.enabled: true` in config.yaml |
| Worker fails to start | Run `python scripts/asr/glm-asr-transformers-worker.py --model zai-org/GLM-ASR-Nano-2512` manually |
| "Module not found" errors | Re-run setup script |
| Model download too slow | `$env:HF_ENDPOINT = "https://hf-mirror.com"` before setup |
| High CPU | Reduce `maxConcurrent` to 1 |

## Reference

- Source: `src/asr/` (config, local process, persistent worker)
- Config defaults: `src/asr/glm-asr-config.ts`
- Design: `doc/design/features/glm-asr-module.md`
- Code: `doc/code/modules/asr-runtime.md`
