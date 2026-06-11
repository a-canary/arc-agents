# Task T03: Counterfactual Design Critique

**Category:** Analytical critique / Engineering reasoning
**Difficulty:** Medium-Hard
**Expected tokens:** ~6,000–12,000 input + ~2,000–4,000 output

## Problem Statement

> "Evaluate whether the Rust ownership model was the right trade-off for systems programming by 2025. Compare it against: (a) the status quo (C/C++ with sanitizers + bounds checking), (b) a hypothetical linear-type system, and (c) a region-based memory management system. For each alternative, identify the specific problem it solves well, the new problems it creates, and what evidence would falsify the claim that Rust's model is net-positive for safety-critical embedded firmware."

## Requirements

1. Identify Rust's top 3 genuine safety wins (with specific examples of bugs prevented)
2. Identify Rust's top 3 genuine safety losses or unsolved problems (with specific examples)
3. For each alternative (C/C++, linear types, region-based):
   - The specific problem it handles better than Rust
   - The specific new problem it introduces that Rust handles better
   - Whether evidence exists to falsify the claim (define the falsifiable test)
4. State your overall verdict with explicit criteria that would make you change your mind
5. Address the embedded / firmware context specifically (not general systems programming)

## Quality Bar

- Concrete examples — no abstract platitudes about safety
- Falsifiability: each claim must have a defined "evidence that would disprove me"
- 400–700 words
