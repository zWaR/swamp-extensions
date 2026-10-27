# Release notes

## 2026.10.27.1

**Added:** `usageReport` and the `usage` resource. It reads the invocations of an `@cachehit/agents` model and stores
Kiro credits, runs, failures, retries and duration per job and role, with untagged runs counted as unattributed.
`workItem` and `filterTags` limit a report to one work item or one workflow run.

## 2026.10.26.1

**Added:** First release. `resolveDispatch` and `recordFallback` select a model per role from your catalog and fall back
to the next tier on rate limits, quota and unavailable models, reading failures from `@cachehit/agents`.
