# Release notes

## 2026.10.27.1

**Added:** Invocations record every attempt in `attempts` (attempt number, exit code, failure class, error, credits,
requests, duration) and the summed model `requests`.

**Changed:** credits now sums every attempt, so retried runs are counted.

## 2026.10.26.1

**Added:** First release with `@cachehit/agents/kiro`. `invoke`, `invokeAndParse` and `listModels` run Kiro CLI
headless and record the model, credits, duration, tool calls and failure class of every run.
