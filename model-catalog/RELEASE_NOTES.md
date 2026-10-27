# Release notes

## 2026.10.27.3

**Added:** The workflow report `@cachehit/model-catalog/usage-summary`. Required in a workflow, it shows at the end of
the run the Kiro credits, Claude Code cost and tokens, agent time and wall time of each `@cachehit/agents` run and each
role.

## 2026.10.27.2

**Added:** Tiers can use `provider: claude` for `@cachehit/agents/claude`. `usageReport` sums Claude Code `costUsd` and
`tokens` per bucket (null when no invocation reported them), and `agentModel` takes a list of agent models.

**Changed:** The usage report has `agentModels` (a list) instead of `agentModel`, and no longer has `unit` or
`tokensAvailable`.

## 2026.10.27.1

**Added:** `usageReport` and the `usage` resource. It reads the invocations of an `@cachehit/agents` model and stores
Kiro credits, runs, failures, retries and duration per job and role, with untagged runs counted as unattributed.
`workItem` and `filterTags` limit a report to one work item or one workflow run.

## 2026.10.26.1

**Added:** First release. `resolveDispatch` and `recordFallback` select a model per role from your catalog and fall back
to the next tier on rate limits, quota and unavailable models, reading failures from `@cachehit/agents`.
