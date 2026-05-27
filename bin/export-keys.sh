#!/usr/bin/env python3
"""
Read API keys from ~/repos/conjecture/.conjecture/config.json and print
shell-export commands. Used by run-benchmark.sh.

Usage:
  source <(python3 bin/export-keys.sh)   # bash
  eval (python3 bin/export-keys.sh)      # fish
"""

import json
import os
import sys
from pathlib import Path

DEPRECATED_MODELS = {
    "deepseek-ai/DeepSeek-V3": "deepseek-ai/DeepSeek-V3.2-TEE",
    "deepseek-ai/DeepSeek-V3-0324": "deepseek-ai/DeepSeek-V3.2-TEE",
}

def load_conjecture_config():
    config_path = Path.home() / "repos" / "conjecture" / ".conjecture" / "config.json"
    if not config_path.exists():
        raise FileNotFoundError(f"Config not found: {config_path}")
    with open(config_path) as f:
        return json.load(f)


def export_keys():
    """Print shell-export commands for API keys."""
    config = load_conjecture_config()

    chutes_key = None
    chutes_url = None

    for p in config.get("providers", []):
        name = p.get("name", "").lower()
        if name == "chutes":
            chutes_key = p.get("api", "")
            raw_url = p.get("url", "")
            # Normalize URL: api.chutes.ai returns "No matching chute found"
            if "api.chutes.ai" in raw_url:
                chutes_url = "https://llm.chutes.ai/v1/chat/completions"
            else:
                chutes_url = raw_url or "https://llm.chutes.ai/v1/chat/completions"

    if not chutes_key:
        print("# ERROR: No Chutes API key found in config", file=sys.stderr)
        sys.exit(1)

    print(f"export CHUTES_API_KEY='{chutes_key}'")
    print(f"export CHUTES_URL='{chutes_url}'")

    # Patch deprecated model names
    model = os.environ.get("BENCHMARK_MODEL", "")
    if model in DEPRECATED_MODELS:
        print(f"export BENCHMARK_MODEL='{DEPRECATED_MODELS[model]}'")

    openrouter_key = None
    for p in config.get("providers", []):
        name = p.get("name", "").lower()
        if name == "openrouter":
            openrouter_key = p.get("api", "")
    if openrouter_key and openrouter_key != "not-needed":
        print(f"export OPENROUTER_API_KEY='{openrouter_key}'")


if __name__ == "__main__":
    export_keys()