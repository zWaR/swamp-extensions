# Release notes

## 2026.11.03.1

**Added:** `invoke` and `invokeAndParse` log the agent's progress while it runs: one info line per tool call, plus
each assistant message for Claude Code and failed tool calls and run errors for Kiro. The lines are on by default and
show in the terminal without `--log`. Turn them off with the `progress` input or global argument set to `false`.

## 2026.10.27.2

**Added:** `@cachehit/agents/claude` runs Claude Code (`claude -p`) headless with `invoke` and `invokeAndParse`, the
same tool profiles and the same invocation records. Invocations record `costUsd` and `tokens` (null for Kiro).

## 2026.10.27.1

**Added:** Invocations record every attempt in `attempts` (attempt number, exit code, failure class, error, credits,
requests, duration) and the summed model `requests`.

**Changed:** credits now sums every attempt, so retried runs are counted.

## 2026.10.26.1

**Added:** First release with `@cachehit/agents/kiro`. `invoke`, `invokeAndParse` and `listModels` run Kiro CLI
headless and record the model, credits, duration, tool calls and failure class of every run.
