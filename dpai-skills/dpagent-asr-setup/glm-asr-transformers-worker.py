#!/usr/bin/env python3
"""Persistent GLM-ASR JSONL worker for DPAgent."""

from __future__ import annotations

import json
import argparse
import sys
import time
import traceback
from typing import Any

def emit(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=True), flush=True)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run persistent GLM-ASR JSONL worker.")
    parser.add_argument("--model", default="zai-org/GLM-ASR-Nano-2512")
    parser.add_argument("--max-new-tokens", type=int, default=500)
    return parser.parse_args()


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if hasattr(sys.stdin, "reconfigure"):
        sys.stdin.reconfigure(encoding="utf-8")
    args = parse_args()
    try:
        from transformers import AutoModelForSeq2SeqLM, AutoProcessor
    except Exception as exc:  # pragma: no cover - operator environment specific.
        emit({"type": "error", "error": {"code": "ASR_DEPENDENCY_MISSING", "message": str(exc)}})
        return 2

    try:
        processor = AutoProcessor.from_pretrained(args.model)
        model = AutoModelForSeq2SeqLM.from_pretrained(args.model, device_map="auto")
    except Exception as exc:  # pragma: no cover - operator environment specific.
        emit({"type": "error", "error": {"code": "ASR_MODEL_LOAD_FAILED", "message": str(exc)}})
        return 3

    emit({"type": "ready", "model": args.model})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        started = time.monotonic()
        try:
            request = json.loads(line)
            request_id = str(request.get("id") or "")
            audio_path = str(request.get("audioPath") or "")
            language = str(request.get("language") or "auto")
            inputs = processor.apply_transcription_request(audio_path)
            inputs = inputs.to(model.device, dtype=model.dtype)
            outputs = model.generate(**inputs, do_sample=False, max_new_tokens=args.max_new_tokens)
            decoded = processor.batch_decode(
                outputs[:, inputs.input_ids.shape[1] :],
                skip_special_tokens=True,
            )
            text = decoded[0].strip() if decoded else ""
            emit(
                {
                    "id": request_id,
                    "result": {
                        "text": text,
                        "language": None if language == "auto" else language,
                        "durationMs": int((time.monotonic() - started) * 1000),
                        "model": args.model,
                    },
                }
            )
        except Exception as exc:  # pragma: no cover - operator/model specific.
            request_id = ""
            try:
                request_id = str(json.loads(line).get("id") or "")
            except Exception:
                pass
            emit(
                {
                    "id": request_id,
                    "error": {
                        "code": "ASR_TRANSCRIBE_FAILED",
                        "message": str(exc),
                        "trace": traceback.format_exc(limit=3),
                    },
                }
            )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
