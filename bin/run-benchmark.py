#!/usr/bin/env python3
"""
Run O-0008 benchmark scripts with API keys and URL/model patching.
Reads ~/repos/conjecture/.conjecture/config.json for credentials.
Patches:
  - api.chutes.ai → llm.chutes.ai (correct endpoint)
  - deepseek-ai/DeepSeek-V3 → deepseek-ai/DeepSeek-V3.2-TEE (available model)
"""

import asyncio
import json
import os
import subprocess
import sys
import time
from pathlib import Path

CHUTES_CORRECT_URL = "https://llm.chutes.ai/v1/chat/completions"
CHUTES_MODEL = "deepseek-ai/DeepSeek-V3.2-TEE"

# Deprecated model names to patch
DEPRECATED_MODELS = {
    "deepseek-ai/DeepSeek-V3": CHUTES_MODEL,
    "deepseek-ai/DeepSeek-V3-0324": CHUTES_MODEL,
}

# URL aliases to correct
BAD_URL_PREFIXES = ["https://api.chutes.ai"]


def load_chutes_config() -> tuple[str, str]:
    """Return (api_key, url) from conjecture config."""
    config_path = Path.home() / "repos" / "conjecture" / ".conjecture" / "config.json"
    with open(config_path) as f:
        config = json.load(f)
    for p in config.get("providers", []):
        if p.get("name", "").lower() == "chutes":
            raw_url = p.get("url", CHUTES_CORRECT_URL)
            # Normalize bad URL
            for bad in BAD_URL_PREFIXES:
                if raw_url.startswith(bad):
                    url = CHUTES_CORRECT_URL
                    break
            else:
                url = raw_url or CHUTES_CORRECT_URL
            return p.get("api", ""), url
    raise RuntimeError("No Chutes provider in config")


def build_env(benchmark_script: str, extra_args: list[str]) -> dict:
    """Build environment with patched API keys for benchmark script."""
    api_key, url = load_chutes_config()
    env = dict(os.environ)
    env["CHUTES_API_KEY"] = api_key
    env["CHUTES_URL"] = url
    # Patch deprecated model
    current_model = env.get("BENCHMARK_MODEL", "")
    if current_model in DEPRECATED_MODELS:
        env["BENCHMARK_MODEL"] = DEPRECATED_MODELS[current_model]
    else:
        # Also check in args passed to script (benchmark scripts use argparse)
        pass
    return env


async def run_benchmark_script(
    script_name: str,
    n_problems: int,
    extra_args: list[str] | None = None,
    timeout: int = 600,
) -> subprocess.CompletedProcess:
    """Run a benchmark script as subprocess with correct env."""
    api_key, _ = load_chutes_config()
    env = dict(os.environ)
    env["CHUTES_API_KEY"] = api_key
    env["CHUTES_URL"] = CHUTES_CORRECT_URL
    env["BENCHMARK_MODEL"] = CHUTES_MODEL

    script_path = Path.home() / "repos" / "conjecture" / "experiments" / script_name
    if not script_path.exists():
        raise FileNotFoundError(f"Script not found: {script_path}")

    args = [str(script_path), "-n", str(n_problems)]
    if extra_args:
        args.extend(extra_args)

    print(f"Running: {script_name} -n {n_problems}")
    t0 = time.time()

    proc = await asyncio.create_subprocess_exec(
        sys.executable,
        *args,
        cwd=str(script_path.parent),
        env=env,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )

    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        elapsed = time.time() - t0
        print(f"Completed in {elapsed:.0f}s, exit={proc.returncode}")
        return subprocess.CompletedProcess(args, proc.returncode, stdout, stderr)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        raise TimeoutError(f"{script_name} timed out after {timeout}s")


def run_benchmark_sync(
    script_name: str,
    n_problems: int,
    extra_args: list[str] | None = None,
    timeout: int = 600,
) -> subprocess.CompletedProcess:
    """Synchronous wrapper for run_benchmark_script."""
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(
            run_benchmark_script(script_name, n_problems, extra_args, timeout)
        )
    finally:
        loop.close()


def main():
    import argparse

    parser = argparse.ArgumentParser(description="Run O-0008 benchmark scripts")
    parser.add_argument("script", nargs="?", default="drop_benchmark.py")
    parser.add_argument("-n", "--n", type=int, default=20)
    parser.add_argument("--timeout", type=int, default=600)
    args = parser.parse_args()

    result = run_benchmark_sync(args.script, args.n, timeout=args.timeout)

    # Print output
    if result.stdout:
        for line in result.stdout.decode().splitlines():
            print(line)
    if result.returncode != 0 and result.stderr:
        print("STDERR:", result.stderr.decode()[:500], file=sys.stderr)

    sys.exit(result.returncode)


if __name__ == "__main__":
    main()