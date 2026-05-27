#!/usr/bin/env python3
"""
Read API keys from conjecture workspace config and export to environment.
Also patches deprecated model names for Chutes API compatibility.
"""

import json
import os
import sys
from pathlib import Path

DEPRECATED_MODELS = {
    "deepseek-ai/DeepSeek-V3": "deepseek-ai/DeepSeek-V3.2-TEE",
    "deepseek-ai/DeepSeek-V3-0324": "deepseek-ai/DeepSeek-V3.2-TEE",
}

def load_keys():
    """Load API keys from conjecture config.json."""
    config_path = Path.home() / "repos" / "conjecture" / ".conjecture" / "config.json"

    if not config_path.exists():
        raise FileNotFoundError(f"Config not found at {config_path}")

    with open(config_path) as f:
        config = json.load(f)

    chutes_key = None
    chutes_url = None

    for p in config.get("providers", []):
        name = p.get("name", "").lower()
        if name == "chutes":
            chutes_key = p.get("api", "")
            chutes_url = p.get("url", "https://llm.chutes.ai/v1/chat/completions")

    if not chutes_key:
        raise ValueError("No Chutes API key found in config")

    return chutes_key, chutes_url


def export_keys():
    """Print shell-export commands for benchmark scripts."""
    try:
        chutes_key, chutes_url = load_keys()
    except (FileNotFoundError, ValueError) as e:
        print(f"# ERROR: {e}", file=sys.stderr)
        sys.exit(1)

    print(f"export CHUTES_API_KEY='{chutes_key}'")
    print(f"export CHUTES_URL='{chutes_url}'")

    # Patch model if deprecated
    model = os.environ.get("BENCHMARK_MODEL", os.environ.get("DEFAULT_MODEL", ""))
    if model in DEPRECATED_MODELS:
        new_model = DEPRECATED_MODELS[model]
        print(f"export BENCHMARK_MODEL='{new_model}'")


if __name__ == "__main__":
    export_keys()