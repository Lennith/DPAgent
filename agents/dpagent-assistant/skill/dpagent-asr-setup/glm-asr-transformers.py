#!/usr/bin/env python3
"""Local GLM-ASR Transformers runner for DPAgent.

This script is a thin optional bridge. DPAgent's Node runtime owns
configuration, validation, timeout, and result parsing; Python owns local model
invocation when the operator installs the required ML dependencies.
"""

from __future__ import annotations

import argparse
import json
import sys
import time


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Transcribe audio with local GLM-ASR.")
    parser.add_argument("--model", default="zai-org/GLM-ASR-Nano-2512")
    parser.add_argument("--audio", required=True)
    parser.add_argument("--language", default="auto")
    parser.add_argument("--max-new-tokens", type=int, default=500)
    parser.add_argument("--json", action="store_true", dest="json_output")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    started = time.monotonic()
    try:
        from transformers import AutoModelForSeq2SeqLM, AutoProcessor
    except Exception as exc:  # pragma: no cover - operator environment specific.
        print(
            "Missing GLM-ASR dependencies. Install transformers from source and the "
            f"audio runtime dependencies before running local ASR. Detail: {exc}",
            file=sys.stderr,
        )
        return 2

    processor = AutoProcessor.from_pretrained(args.model)
    model = AutoModelForSeq2SeqLM.from_pretrained(args.model, device_map="auto")
    inputs = processor.apply_transcription_request(args.audio)
    inputs = inputs.to(model.device, dtype=model.dtype)
    outputs = model.generate(**inputs, do_sample=False, max_new_tokens=args.max_new_tokens)
    decoded = processor.batch_decode(
        outputs[:, inputs.input_ids.shape[1] :],
        skip_special_tokens=True,
    )
    text = decoded[0].strip() if decoded else ""
    if args.json_output:
        print(
            json.dumps(
                {
                    "text": text,
                    "language": None if args.language == "auto" else args.language,
                    "durationMs": int((time.monotonic() - started) * 1000),
                    "model": args.model,
                },
                ensure_ascii=False,
            )
        )
    else:
        print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
