# @cachehit/model-catalog

Choose which model each kind of work uses, and fall back to the next model when one is rate limited, out of quota or
unavailable. It's built for agent steps run with
[`@cachehit/agents`](https://github.com/zWaR/swamp-extensions/tree/main/agents) (Kiro CLI), and reads their invocation
records directly.

It follows the design of `@mgreten/agent-provider-catalog`: a caller-owned table of roles and ordered tiers, fallback
only on throttling-type failures, and idempotent records per (work item, role, attempt). The differences:

- Tiers name Kiro models; `provider` defaults to `kiro`.
- Roles are your own names (`implementer`, `docs-writer`, …), not a fixed list. `roleMap` still folds aliases onto them.
- A tier can also set the `toolProfile` and `effort` the agent step should use.
- `model-unavailable` advances a tier as well as `rate-limit` and `quota`, since another Kiro model is a real
  alternative.
- When the failure is read from an invocation, the current tier is inferred from that invocation's model.

## Prerequisites

- [swamp](https://github.com/swamp-club/swamp) CLI
- [`@cachehit/agents`](https://github.com/zWaR/swamp-extensions/tree/main/agents) to run the steps the catalog chooses
  models for

## Installation

```bash
swamp extension pull @cachehit/model-catalog
```

## The catalog

```json
{
  "version": "1",
  "roles": {
    "classifier": {
      "tiers": [
        { "model": "qwen3-coder-next", "costClass": "low", "toolProfile": "readonly" },
        { "model": "claude-haiku-4.5", "costClass": "low", "toolProfile": "readonly" }
      ]
    },
    "implementer": {
      "tiers": [
        { "model": "claude-haiku-4.5", "costClass": "low", "toolProfile": "actor" },
        { "model": "claude-sonnet-4.6", "costClass": "medium", "toolProfile": "actor", "effort": "high" }
      ]
    },
    "reviewer": {
      "tiers": [{ "model": "claude-opus-4.8", "costClass": "high", "toolProfile": "readonly" }]
    }
  }
}
```

Tier 0 is the default for a role; each later tier is the next fallback. A role must not list the same model twice.
`swamp model method run <kiro-model> listModels` stores the model IDs Kiro offers, with their credit rate multipliers.

```bash
swamp model create @cachehit/model-catalog catalog \
  --global-arg "catalog=$(cat catalog.json)" \
  --global-arg 'roleMap={"security-review":"reviewer"}'
```

Global arguments:

| Argument        | Default                                   | Purpose                                                    |
| --------------- | ----------------------------------------- | ---------------------------------------------------------- |
| `catalog`       | (required)                                | `version` and `roles`, each with ordered `tiers`           |
| `roleMap`       | `{}`                                      | Alias to catalog role; every target must be a catalog role |
| `signalTagKeys` | `{"workItem":"workItem","phase":"phase"}` | Invocation tag keys that identify the work item and phase  |

Tier fields: `model` and `costClass` (`low`, `medium`, `high`; advisory) are required. `toolProfile` (`readonly`,
`actor`), `effort` (`low` to `max`), `notes` and `provider` (`kiro`) are optional.

## Methods

### `resolveDispatch`

Stores, as `dispatch--<workItem>--<role>--<attempt>`, the tier a step should use:

```bash
swamp model method run catalog resolveDispatch \
  --input workItem=WI-42 --input role=implementer --input instanceName=kiro --input attempt=1
```

| Argument       | Default        | Purpose                                                                              |
| -------------- | -------------- | ------------------------------------------------------------------------------------ |
| `workItem`     | (required)     | Task identifier; letters and digits joined by single `.`, `_` or `-`                 |
| `role`         | (required)     | Catalog role or `roleMap` alias                                                      |
| `instanceName` | (required)     | Agent step or model instance; recorded unchanged                                     |
| `attempt`      | `1`            | 1-based attempt number                                                               |
| `signalClass`  | (none)         | Failure class of the previous attempt                                                |
| `phase`        | (none)         | Without `signalClass`: read the newest invocation tagged with `workItem` and `phase` |
| `agentModel`   | `instanceName` | `@cachehit/agents` model instance to read invocations from                           |
| `currentTier`  | inferred or 0  | Tier of the previous attempt; inferred from the failed invocation's model            |
| `maxAttempts`  | `3`            | Park instead of advancing once `attempt` reaches this                                |

The record has `model`, `tier`, `toolProfile`, `effort`, `provider` and `costClass`, plus:

- `disposition`: `initial` (no failure signal), `advance` (next tier), `no-fallback` (same tier; the failure is the
  step's own to handle) or `park` (no tier or attempt left; `parked` is true).
- `signalClass` and `signalSource` (`argument` or `invocation`).
- `fallbackRef`: the name of the `fallback--…` decision stored with it, when there was a signal.
- `reasons`, `catalogVersion`, `resolvedAt`.

Calling it again with the same inputs writes nothing. With `phase`, a result already stored for that key is kept as is,
because later runs change what the invocations show. With an explicit `signalClass`, a stored result that would now
differ is an error: use the next attempt number.

### `recordFallback`

Stores only the decision, as `fallback--<workItem>--<role>--<attempt>`:

```bash
swamp model method run catalog recordFallback \
  --input workItem=WI-42 --input role=implementer --input signalClass=rate-limit --input currentTier=0
```

### `usageReport`

Reads the invocations of an `@cachehit/agents` model and stores, as `usage--<reportName>`, Kiro credits, runs, failures,
retries and duration per job and role:

```bash
swamp model method run catalog usageReport --input agentModel=kiro
```

| Argument     | Default    | Purpose                                                                                  |
| ------------ | ---------- | ---------------------------------------------------------------------------------------- |
| `agentModel` | (required) | `@cachehit/agents/kiro` model instance to read invocations from                          |
| `reportName` | `latest`   | Name of the stored report; a new run with the same name replaces it                      |
| `workItem`   | (none)     | Keep only invocations whose tag under `signalTagKeys.workItem` equals this               |
| `filterTags` | `{}`       | Keep only invocations with all of these tags, for example `{"workflowRunId":"<run ID>"}` |
| `jobTagKey`  | `job`      | Tag key that holds the workflow job; swamp sets `job` on data a workflow step writes     |
| `roleTagKey` | `role`     | Invocation tag key that holds the role; folded through `roleMap`, unknown roles stay     |

The report is a snapshot: each run overwrites it. It has:

- `reportName`, `agentModel`, `workItem` (`null` without the argument) and `generatedAt`.
- `unit`: `credits`. `tokensAvailable` is `false`, because Kiro reports credits, not tokens.
- `totals`: every counted invocation.
- `byRole`: one bucket per role.
- `jobs`: one entry per job, ordered by its earliest `startedAt`, each with `job`, `total` and `roles` (a bucket per
  role).
- `unattributed`: invocations missing the job or the role tag. They count in `totals` but in no role or job.

Each bucket has:

- `invocations`, `succeeded` and `failed`.
- `credits`: the sum of the known credits, rounded to 6 decimals. `creditsMissing` counts invocations without credits.
- `retries`: extra attempts, from each invocation's `attempts`.
- `durationMs`: summed duration.
- `models`: invocation count per model.

Role tags are folded through `roleMap`; a role that is not in the catalog is kept under its own name. Records that are
not invocation records are skipped.

## Fallback rules

| Failure class                                                                                          | Result                    |
| ------------------------------------------------------------------------------------------------------ | ------------------------- |
| `rate-limit`, `quota`, `model-unavailable`                                                             | Next tier, or park        |
| `auth`, `timeout`, `contract-violation`, `infrastructure`, `test-failure`, `agent-declined`, `unknown` | Stay on the tier          |
| Anything else                                                                                          | Error; nothing is written |

The failure classes are those of `@cachehit/agents` plus `test-failure` and `agent-declined` for outcomes a workflow
reports itself. A cheap model doing poor work is not a fallback trigger: to send that work to a stronger model, use a
different role, such as `reviewer`.

## Using it with `@cachehit/agents`

Tag each agent run with the work item and phase, and let the next attempt read the failure:

```bash
# Attempt 1: choose the model, then run it
swamp model method run catalog resolveDispatch \
  --input workItem=WI-42 --input role=implementer --input instanceName=kiro
swamp model method run kiro invoke \
  --input model=claude-haiku-4.5 --input toolProfile=actor --input cwd=/path/to/worktree \
  --input prompt="..." --input invocationId=WI-42-implementer-1 \
  --input 'tags:json={"workItem":"WI-42","phase":"implement"}'

# Attempt 2, after a failure: reads the failed invocation from the kiro model
swamp model method run catalog resolveDispatch \
  --input workItem=WI-42 --input role=implementer --input instanceName=kiro \
  --input phase=implement --input attempt=2
```

In a workflow, pass the choice to the agent step with
`data.latest("catalog", "dispatch--WI-42--implementer--1").attributes.model`, and likewise `toolProfile` and `effort`.

### Tagging runs for usage reports

`usageReport` reads tags from two places, and the invocation's own tags win when both set a key:

- Swamp tags every record a workflow step writes with `job`, `step`, `workflow` and `workflowRunId`, so runs inside a
  workflow get their job without any setup.
- The `tags` input of `@cachehit/agents/kiro` `invoke` and `invokeAndParse`. Set `role` there on every agent run, and
  `workItem` to filter by work item. Runs outside a workflow also need `job`.

Runs without a job or role are counted only under `unattributed`. To report one workflow run:

```yaml
tags:
  role: worker
  workItem: ${{ inputs.workItem }}
```

```bash
swamp model method run catalog usageReport --input agentModel=kiro --input reportName=WI-42 \
  --input 'filterTags:json={"workflowRunId":"<workflow run ID>"}'
swamp data get catalog usage--WI-42 --json
```

## Data

| Resource   | Name                                | Content                                          |
| ---------- | ----------------------------------- | ------------------------------------------------ |
| `dispatch` | `dispatch--<workItem>--<role>--<n>` | The tier and settings for attempt `n`            |
| `fallback` | `fallback--<workItem>--<role>--<n>` | The decision, with from and to tiers and reasons |
| `usage`    | `usage--<reportName>`               | Credits, runs and failures per job and role      |

`dispatch` and `fallback` keep the last 40 versions and don't expire. `usage` keeps the last 40 versions for 30 days.

## Limitations

- Only Kiro models; tiers can't mix agent CLIs yet.
- The catalog decides; it doesn't run anything. Each step runs the agent itself.
- Reading invocations needs a swamp version whose method context has `readModelData`. Otherwise pass `signalClass`;
  `usageReport` fails without it.
- Usage is in Kiro credits only; there are no token counts.

## License

Apache-2.0. See [LICENSE.md](LICENSE.md).
