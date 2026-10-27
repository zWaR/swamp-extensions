# @cachehit/agents

Run AI coding agents headless from swamp workflows and record what each run did and cost. A workflow can then hand
simple subtasks to a cheap model, keep an expensive model for planning and review, and compare what each step cost: Kiro
credits, or dollars and tokens for Claude Code.

Supported agents:

| Model type                | Agent                                                                 |
| ------------------------- | --------------------------------------------------------------------- |
| `@cachehit/agents/kiro`   | [Kiro CLI](https://kiro.dev/cli/) (`kiro-cli`)                        |
| `@cachehit/agents/claude` | [Claude Code](https://docs.claude.com/en/docs/claude-code) (`claude`) |

Both model types take the same methods, tool profiles and invocation records, so a workflow can mix them; the
[Claude Code](#claude-code) section lists what differs.

## Prerequisites

- [swamp](https://github.com/swamp-club/swamp) CLI
- `kiro-cli` installed and logged in (`kiro-cli login`), or `claude` installed and logged in (`claude /login` or
  `ANTHROPIC_API_KEY`), on the machine that runs the method. The extension only starts the CLI; it uses the CLI's own
  login.

## Installation

```bash
swamp extension pull @cachehit/agents
swamp model create @cachehit/agents/kiro kiro --global-arg defaultModel=claude-haiku-4.5
swamp model create @cachehit/agents/claude claude --global-arg defaultModel=haiku
```

Global arguments of `@cachehit/agents/kiro`:

| Argument             | Default    | Purpose                                                                         |
| -------------------- | ---------- | ------------------------------------------------------------------------------- |
| `kiroPath`           | `kiro-cli` | Executable, resolved on `PATH` unless absolute                                  |
| `defaultModel`       | `auto`     | Kiro model ID used when a call omits `model`                                    |
| `defaultToolProfile` | `readonly` | `readonly` or `actor`; see [Tool profiles](#tool-profiles)                      |
| `defaultAgent`       | (none)     | Kiro agent (context profile) for the `actor` profile; Kiro's default when unset |
| `wallTimeoutMs`      | `1800000`  | Kill a run after this long in total                                             |
| `idleTimeoutMs`      | `600000`   | Kill a run that writes no output for this long                                  |
| `maxRetries`         | `2`        | Retries for rate limits, killed processes and unparseable JSON answers          |
| `retryDelayMs`       | `5000`     | Base backoff; retry n waits n times this                                        |

## Methods

### `listModels`

Stores Kiro's models in the `models` resource. Each model has its `rateMultiplier`: credits relative to the base rate,
for example `0.4` for `claude-haiku-4.5` and `2.2` for `claude-opus-4.8`. Use it to choose the cheap and the strong
model for a workflow.

```bash
swamp model method run kiro listModels
swamp data get kiro models --json | jq '.attributes.models | sort_by(.rateMultiplier)'
```

### `invoke`

Runs `kiro-cli chat` with the prompt on stdin and stores the run. The step fails when the run fails, after the records
are stored.

```bash
swamp model method run kiro invoke \
  --input prompt="Explain how the retry logic in src/client.ts works" \
  --input cwd=/path/to/repo \
  --input invocationId=explain-retry \
  --input 'tags:json={"role":"worker"}'
```

| Argument        | Required | Purpose                                                                    |
| --------------- | -------- | -------------------------------------------------------------------------- |
| `prompt`        | yes      | Task for the agent                                                         |
| `model`         | no       | Kiro model ID; defaults to `defaultModel`                                  |
| `toolProfile`   | no       | `readonly` or `actor`; defaults to `defaultToolProfile`                    |
| `agent`         | no       | Kiro agent for the `actor` profile; overrides `defaultAgent`               |
| `effort`        | no       | `low`, `medium`, `high`, `xhigh` or `max`, for models that support it      |
| `cwd`           | no       | Working directory of the agent; defaults to the swamp process directory    |
| `invocationId`  | no       | Names the stored data `invocation-<id>` and `transcript-<id>`; random UUID |
| `tags`          | no       | Key-value labels stored with the run                                       |
| `wallTimeoutMs` | no       | Overrides the global value for this run                                    |
| `idleTimeoutMs` | no       | Overrides the global value for this run                                    |

### `invokeAndParse`

Takes the same arguments as `invoke`. The answer must contain a JSON object or array, in a fenced code block or inline.
It's stored as `parsed` on the invocation. When the answer has no JSON, the method asks again, up to `maxRetries` times,
and then fails with failure class `contract-violation`.

```bash
swamp model method run kiro invokeAndParse \
  --input model=claude-opus-4.8 \
  --input prompt='Split this task into subtasks. Answer as JSON: [{"id":..,"prompt":..,"difficulty":"simple|complex"}]. Task: ...'
```

## Claude Code

`@cachehit/agents/claude` runs `claude -p --output-format stream-json`. It has `invoke` and `invokeAndParse` with the
arguments above except `agent`; Claude Code has no model list command, so there is no `listModels`. Its global arguments
are `claudePath` (default `claude`), `defaultModel` (default `sonnet`) and the shared `defaultToolProfile`,
`wallTimeoutMs`, `idleTimeoutMs`, `maxRetries` and `retryDelayMs`. `model` takes an alias (`haiku`, `sonnet`, `opus`) or
a full model ID.

```bash
swamp model method run claude invoke \
  --input prompt="Explain how the retry logic in src/client.ts works" \
  --input cwd=/path/to/repo --input model=haiku
```

Its invocations record `costUsd` and `tokens` from Claude Code's result event; `credits` is null. `costUsd` is the cost
Claude Code reports at API list prices, also when you are on a subscription plan. `requests` is the number of turns.

## Tool profiles

- `readonly` (default): the agent can only read files and search them (`read`, `grep`, `glob`). It can't write files,
  run commands or use MCP servers. The extension writes the Kiro agent `swamp-agents-kiro-readonly` to `~/.kiro/agents/`
  the first time it's needed, and rewrites it if its content changes.
- `actor`: the agent gets every tool of its Kiro agent and `--trust-all-tools`, because a headless run can't answer
  permission prompts. It can edit files and run commands in `cwd` without asking. Use it only for working directories
  and prompts you trust, ideally a dedicated worktree.

For Claude Code, `readonly` passes `--tools Read,Grep,Glob`, `--strict-mcp-config` and `--permission-mode dontAsk`: only
those three built-in tools, no MCP servers, and anything that would need a permission prompt is denied. `--tools` alone
leaves MCP tools available. `actor` passes `--dangerously-skip-permissions` and keeps your MCP servers and settings.

Kiro's `--trust-tools` flag alone doesn't restrict a headless run: in testing with Kiro CLI 2.28.0, the default agent
still ran a shell command that wrote a file. The `readonly` profile therefore restricts the tool list through the agent
config instead.

## Routing work to a cheaper model

A workflow plans with a strong model, runs the simple subtasks on a cheap one and reviews with the strong one again. The
`models`, `invocation` and `transcript` data connect the steps through CEL:

1. `invokeAndParse` with `model: claude-opus-4.8` returns the subtasks with a difficulty.
2. `invoke` with `model: claude-haiku-4.5` for each simple subtask, `invocationId` set to the subtask ID.
3. `invoke` with the strong model to review the transcripts, and rerun failed subtasks on it.

Read a step's answer with `data.latest("kiro", "transcript-<id>").attributes.output` and its cost with
`data.latest("kiro", "invocation-<id>").attributes.credits`.

The extension doesn't decide which subtasks are simple, and it doesn't move a failed subtask to a stronger model on its
own. The planning step and the workflow make those choices.

## Data

| Resource     | Name              | Content                                                                |
| ------------ | ----------------- | ---------------------------------------------------------------------- |
| `invocation` | `invocation-<id>` | Model, profile, outcome, failure class, credits, durations, tool calls |
| `transcript` | `transcript-<id>` | Full prompt and answer, last 4000 characters of stderr                 |
| `models`     | `models`          | Kiro's models with context window and credit rate multiplier           |

An invocation also holds the exit code, error message, retry count, Kiro session ID, the first 1000 characters of the
answer and, from `invokeAndParse`, the `parsed` JSON. Invocations and transcripts expire after 30 days. Transcripts hold
the full prompt and answer, so treat the swamp datastore with the same care as the repository the agent worked on.

Usage fields of an invocation:

| Field      | Content                                                                                      |
| ---------- | -------------------------------------------------------------------------------------------- |
| `credits`  | Kiro credits summed over every attempt, retries included; null when no attempt reported any  |
| `requests` | Model requests (Claude Code: turns) summed over every attempt, the same way as `credits`     |
| `costUsd`  | Claude Code's reported cost in US dollars, summed the same way; null for Kiro                |
| `tokens`   | `input`, `output`, `cacheRead` and `cacheCreation` tokens summed the same way; null for Kiro |
| `attempts` | One entry per attempt, in order; the top-level outcome fields describe the last attempt only |

Each `attempts` entry:

| Field          | Content                                                              |
| -------------- | -------------------------------------------------------------------- |
| `attempt`      | Attempt number, starting at 1                                        |
| `exitCode`     | Exit code of the CLI                                                 |
| `failureClass` | Failure class of the attempt; null when it succeeded                 |
| `error`        | Error message of the attempt; null when it succeeded                 |
| `credits`      | Kiro credits metered for the attempt; null when Kiro reported none   |
| `requests`     | Model requests metered for the attempt; null when Kiro reported none |
| `costUsd`      | Dollar cost of the attempt; null when the CLI reported none          |
| `tokens`       | Token counts of the attempt; null when the CLI reported none         |
| `durationMs`   | Run time of the CLI process                                          |

Failure classes: `rate-limit`, `quota`, `auth`, `model-unavailable`, `timeout`, `contract-violation`, `infrastructure`,
`unknown`. Only `rate-limit` and killed processes (exit 137 or 143) are retried unchanged.

## Limitations

- A retry reruns the whole prompt. With the `actor` profile, changes from the failed attempt stay in `cwd`.
- On timeout, the extension signals the CLI itself, not commands that its tools started.
- Credits come from Kiro's metering events, cost and tokens from Claude Code's result event. When the CLI reports none,
  the field is null.
- The child process gets your environment without `SWAMP_*` variables, apart from `SWAMP_REPO_DIR`, `SWAMP_SERVER_URL`
  and `SWAMP_CLUB_URL`.

## License

Apache-2.0. See [LICENSE.md](LICENSE.md).
