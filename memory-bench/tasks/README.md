# tasks/

Task definitions for the memory-bench harness. Each task is a Markdown
(or YAML) file with a stable id prefix (`t01`, `t02`, …) and a
self-contained problem statement that any `memory-bench-*` Hermes
profile can attempt.

> **Slice ownership:** the task set is selected in slice #1 (HITL).
> Do not register tasks in `harness.py` until slice #1 ships.
