# O-0008 Benchmark API Access

## Status: API Access Provided

API access for O-0008 benchmark execution is now available via two providers:

### Option 1: Chutes API (via Conjecture Config)

The `bin/run-benchmark.sh` script reads credentials from `~/repos/conjecture/.conjecture/config.json` and patches the model name.

**Usage:**
```bash
./bin/run-benchmark.sh drop_benchmark.py -n 20
./bin/run-benchmark.sh math_benchmark.py -n 20
./bin/run-benchmark.sh humaneval_benchmark.py -n 20
```

**What it does:**
- Reads `CHUTES_API_KEY` from conjecture config
- Patches `deepseek-ai/DeepSeek-V3` → `deepseek-ai/DeepSeek-V3.2-TEE` (available model)
- Sets `CHUTES_URL=https://llm.chutes.ai/v1/chat/completions`

### Option 2: MiniMax API (via Environment)

MiniMax API key is available in the environment as `MINIMAX_API_KEY`.

**Usage:**
```bash
cd /home/aaron/repos/conjecture/experiments
CHUTES_URL="https://api.minimax.io/v1/chat/completions" \
CHUTES_API_KEY="$MINIMAX_API_KEY" \
BENCHMARK_MODEL="MiniMax-M2.7" \
python3 drop_benchmark.py -n 20
```

## Available Benchmarks

| Benchmark | Script | Task Type |
|-----------|--------|-----------|
| DROP | `drop_benchmark.py` | Reading comprehension with discrete reasoning |
| MATH | `math_benchmark.py` | Competition mathematics |
| HumanEval | `humaneval_benchmark.py` | Code generation |

## Verification

Both API providers were tested successfully:
- Chutes: `deepseek-ai/DeepSeek-V3.2-TEE` via `https://llm.chutes.ai/v1/chat/completions`
- MiniMax: `MiniMax-M2.7` via `https://api.minimax.io/v1/chat/completions`

## Next Steps

The sibling task `execute-o-0008-drop-math-humaneval-bench-n3y9` is ready to run the benchmarks once API access is confirmed. See that task for benchmark execution details.
