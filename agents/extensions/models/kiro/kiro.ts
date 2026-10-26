/**
 * Runs Kiro CLI (`kiro-cli chat`) headless with a prompt and records the
 * answer, credits, duration, tool calls and failure class, so a workflow can
 * hand subtasks to a cheaper model and check what each one cost.
 *
 * @module
 */
// SPDX-License-Identifier: Apache-2.0

import { z } from "npm:zod@4.6.5";
import { childEnv, type ProcessResult, runProcess } from "./_lib/process.ts";
import {
  classifyFailure,
  FAILURE_CLASSES,
  type FailureClass,
  isRetryable,
  parseJsonAnswer,
  parseStream,
  type StreamSummary,
} from "./_lib/stream.ts";

/** Kiro agent written to ~/.kiro/agents for the readonly tool profile. */
export const READONLY_AGENT_NAME = "swamp-agents-kiro-readonly";
// Not `code`: its pattern_rewrite operation writes files.
const READONLY_TOOLS = ["read", "grep", "glob"];

/** The readonly agent config: file reading and code search tools only. */
export function readonlyAgentConfig(): string {
  return `${
    JSON.stringify(
      {
        name: READONLY_AGENT_NAME,
        description:
          "Read-only agent for @cachehit/agents/kiro: reads and searches files, cannot write or run commands",
        prompt: null,
        mcpServers: {},
        tools: READONLY_TOOLS,
        allowedTools: READONLY_TOOLS,
        resources: [],
        hooks: {},
        useLegacyMcpJson: false,
      },
      null,
      2,
    )
  }\n`;
}

const ToolProfileSchema = z.enum(["readonly", "actor"]);
type ToolProfile = z.infer<typeof ToolProfileSchema>;
const EffortSchema = z.enum(["low", "medium", "high", "xhigh", "max"]);
const TimeoutSchema = z.number().int().min(1_000).max(21_600_000);

const GlobalArgsSchema = z.object({
  kiroPath: z.string().min(1).default("kiro-cli").describe(
    "kiro-cli executable, resolved on PATH unless absolute",
  ),
  defaultModel: z.string().min(1).default("auto").describe(
    "Kiro model ID used when invoke omits model; see listModels",
  ),
  defaultToolProfile: ToolProfileSchema.default("readonly").describe(
    "readonly: read and search files only; actor: every tool of the agent, trusted without prompts",
  ),
  defaultAgent: z.string().min(1).optional().describe(
    "Kiro agent (context profile) for the actor profile; Kiro's default agent when unset",
  ),
  wallTimeoutMs: TimeoutSchema.default(1_800_000).describe(
    "Kill a run after this long in total",
  ),
  idleTimeoutMs: TimeoutSchema.default(600_000).describe(
    "Kill a run that writes no output for this long",
  ),
  maxRetries: z.number().int().min(0).max(5).default(2).describe(
    "Retries for rate limits, killed processes and, in invokeAndParse, unparseable answers",
  ),
  retryDelayMs: z.number().int().min(0).max(300_000).default(5_000).describe(
    "Base backoff; attempt n waits n times this",
  ),
});
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const InvokeArgsSchema = z.object({
  prompt: z.string().min(1).describe("Task for the agent; sent on stdin"),
  model: z.string().min(1).optional().describe(
    "Kiro model ID, for example claude-haiku-4.5; defaults to defaultModel",
  ),
  toolProfile: ToolProfileSchema.optional().describe(
    "Overrides defaultToolProfile",
  ),
  agent: z.string().min(1).optional().describe(
    "Kiro agent for the actor profile; overrides defaultAgent",
  ),
  effort: EffortSchema.optional().describe(
    "Reasoning effort, for models that support it",
  ),
  cwd: z.string().min(1).optional().describe(
    "Working directory for the agent; defaults to the swamp process directory",
  ),
  invocationId: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/).optional()
    .describe(
      "Names the invocation-<id> and transcript-<id> data; a random UUID when unset",
    ),
  tags: z.record(z.string(), z.string()).default({}).describe(
    "Key-value labels stored with the invocation, for example a task role",
  ),
  wallTimeoutMs: TimeoutSchema.optional(),
  idleTimeoutMs: TimeoutSchema.optional(),
});
type InvokeArgs = z.infer<typeof InvokeArgsSchema>;

const InvocationSchema = z.object({
  invocationId: z.string(),
  model: z.string(),
  toolProfile: ToolProfileSchema,
  agent: z.string().nullable(),
  effort: EffortSchema.nullable(),
  cwd: z.string(),
  promptPreview: z.string(),
  promptTruncated: z.boolean(),
  promptSha256: z.string(),
  success: z.boolean(),
  exitCode: z.number(),
  failureClass: z.enum(FAILURE_CLASSES).nullable(),
  error: z.string().nullable(),
  retries: z.number(),
  durationMs: z.number(),
  sessionId: z.string().nullable(),
  stopReason: z.string().nullable(),
  credits: z.number().nullable(),
  turnDurationMs: z.number().nullable(),
  contextUsagePercentage: z.number().nullable(),
  toolCalls: z.array(z.object({
    name: z.string(),
    title: z.string(),
    status: z.string().nullable(),
  })),
  outputPreview: z.string(),
  outputBytes: z.number(),
  parsed: z.unknown().optional(),
  tags: z.record(z.string(), z.string()),
  startedAt: z.string(),
  finishedAt: z.string(),
});

const TranscriptSchema = z.object({
  invocationId: z.string(),
  prompt: z.string(),
  output: z.string(),
  stderrTail: z.string(),
});

const ModelListSchema = z.object({
  defaultModel: z.string().nullable(),
  models: z.array(z.object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    contextWindowTokens: z.number().nullable(),
    rateMultiplier: z.number().nullable(),
    rateUnit: z.string().nullable(),
  })),
  listedAt: z.string(),
});

type Handle = Record<string, unknown>;
type Logger = (message: string, fields?: Record<string, unknown>) => void;
type Ctx = {
  globalArgs: GlobalArgs;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<Handle>;
  logger: { info: Logger; warning: Logger };
};

/** Command-line arguments for one headless `kiro-cli chat` run. */
export function buildChatArgs(opts: {
  model: string;
  toolProfile: ToolProfile;
  agent: string | null;
  effort: string | null;
}): string[] {
  const args = [
    "chat",
    "--model",
    opts.model,
    "--output-format",
    "stream-json",
  ];
  if (opts.toolProfile === "readonly") {
    args.push(
      "--agent",
      READONLY_AGENT_NAME,
      `--trust-tools=${READONLY_TOOLS.join(",")}`,
    );
  } else {
    // A headless run cannot answer permission prompts.
    if (opts.agent) args.push("--agent", opts.agent);
    args.push("--trust-all-tools");
  }
  if (opts.effort) args.push("--effort", opts.effort);
  return args;
}

/** Writes the readonly agent to ~/.kiro/agents when missing or outdated. */
async function ensureReadonlyAgent(home: string | undefined): Promise<void> {
  if (!home) {
    throw new Error("HOME is not set; cannot install the readonly agent");
  }
  const dir = `${home}/.kiro/agents`;
  const path = `${dir}/${READONLY_AGENT_NAME}.json`;
  const want = readonlyAgentConfig();
  const have = await Deno.readTextFile(path).catch(() => null);
  if (have === want) return;
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(path, want);
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(
    new Uint8Array(digest),
    (b) => b.toString(16).padStart(2, "0"),
  )
    .join("");
}

interface Attempt {
  process: ProcessResult;
  stream: StreamSummary;
  ok: boolean;
  failure: FailureClass | null;
  error: string | null;
  parsed: unknown | null;
}

/** Judges one finished process run. */
function judge(process: ProcessResult, requireJson: boolean): Attempt {
  const stream = parseStream(process.stdout);
  const ran = process.code === 0 && !process.timedOut && !stream.error &&
    stream.status === "success";
  const parsed = ran && requireJson ? parseJsonAnswer(stream.text) : null;
  if (ran && (!requireJson || parsed !== null)) {
    return { process, stream, ok: true, failure: null, error: null, parsed };
  }
  const error = ran
    ? "answer contains no JSON object or array"
    : process.timedOut
    ? `${process.timedOut} timeout after ${process.durationMs}ms`
    : stream.error?.message ??
      (stream.status && stream.status !== "success"
        ? `run finished with status ${stream.status}`
        : process.stderr.trim().slice(-500) || `exit ${process.code}`);
  const failure: FailureClass = ran ? "contract-violation" : classifyFailure(
    `${error}\n${process.stderr}`,
    process.code,
    process.timedOut !== null,
  );
  return { process, stream, ok: false, failure, error, parsed: null };
}

/** Runs Kiro, retrying rate limits, killed processes and (optionally) non-JSON answers. */
async function invoke(
  args: InvokeArgs,
  ctx: Ctx,
  requireJson: boolean,
): Promise<{ handles: Handle[]; attempt: Attempt }> {
  const g = ctx.globalArgs;
  const toolProfile = args.toolProfile ?? g.defaultToolProfile;
  const agent = toolProfile === "actor"
    ? args.agent ?? g.defaultAgent ?? null
    : null;
  if (toolProfile === "readonly" && args.agent) {
    throw new Error(
      "agent applies only to toolProfile actor; readonly uses its own read-only agent",
    );
  }
  const model = args.model ?? g.defaultModel;
  const effort = args.effort ?? null;
  const cwd = args.cwd ?? Deno.cwd();
  const cwdInfo = await Deno.stat(cwd).catch(() => null);
  if (!cwdInfo?.isDirectory) {
    throw new Error(`cwd ${cwd} is not an existing directory`);
  }
  const invocationId = args.invocationId ?? crypto.randomUUID();
  const env = childEnv(Deno.env.toObject());
  if (toolProfile === "readonly") await ensureReadonlyAgent(env.HOME);
  ctx.logger.info("Running Kiro {model} ({profile}) in {cwd} as {id}", {
    model,
    profile: toolProfile,
    cwd,
    id: invocationId,
  });

  const cliArgs = buildChatArgs({ model, toolProfile, agent, effort });
  const startedAt = new Date();
  let prompt = args.prompt;
  let retries = 0;
  let attempt: Attempt;
  while (true) {
    const process = await runProcess(g.kiroPath, cliArgs, {
      cwd,
      stdin: prompt,
      env,
      wallTimeoutMs: args.wallTimeoutMs ?? g.wallTimeoutMs,
      idleTimeoutMs: args.idleTimeoutMs ?? g.idleTimeoutMs,
    });
    attempt = judge(process, requireJson);
    const retry = !attempt.ok && retries < g.maxRetries &&
      (attempt.failure === "contract-violation" ||
        isRetryable(attempt.failure!, process.code));
    if (!retry) break;
    retries++;
    ctx.logger.warning("Kiro {failure}, retrying ({n}/{max})", {
      failure: attempt.failure,
      n: retries,
      max: g.maxRetries,
    });
    if (attempt.failure === "contract-violation") {
      prompt =
        `${args.prompt}\n\nYour previous answer contained no valid JSON. Answer again with exactly one JSON value and nothing else.`;
    }
    await new Promise((r) => setTimeout(r, g.retryDelayMs * retries));
  }

  const { process, stream } = attempt;
  const invocation = await ctx.writeResource(
    "invocation",
    `invocation-${invocationId}`,
    {
      invocationId,
      model,
      toolProfile,
      agent,
      effort,
      cwd,
      promptPreview: args.prompt.slice(0, 500),
      promptTruncated: args.prompt.length > 500,
      promptSha256: await sha256(args.prompt),
      success: attempt.ok,
      exitCode: process.code,
      failureClass: attempt.failure,
      error: attempt.error,
      retries,
      durationMs: Date.now() - startedAt.getTime(),
      sessionId: stream.sessionId,
      stopReason: stream.stopReason,
      credits: stream.credits,
      turnDurationMs: stream.turnDurationMs,
      contextUsagePercentage: stream.contextUsagePercentage,
      toolCalls: stream.toolCalls.map(({ name, title, status }) => ({
        name,
        title,
        status,
      })),
      outputPreview: stream.text.slice(0, 1000),
      outputBytes: new TextEncoder().encode(stream.text).length,
      ...(requireJson ? { parsed: attempt.parsed } : {}),
      tags: args.tags,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
    },
  );
  const transcript = await ctx.writeResource(
    "transcript",
    `transcript-${invocationId}`,
    {
      invocationId,
      prompt: args.prompt,
      output: stream.text,
      stderrTail: process.stderr.slice(-4000),
    },
  );
  ctx.logger.info(
    "Kiro {model}: {status} in {ms}ms, {credits} credits, {tools} tool calls, {retries} retries",
    {
      model,
      status: attempt.ok ? "ok" : attempt.failure,
      ms: process.durationMs,
      credits: stream.credits ?? "unknown",
      tools: stream.toolCalls.length,
      retries,
    },
  );
  return { handles: [invocation, transcript], attempt };
}

/** Throws after the records are stored, so a workflow step fails visibly. */
function failIfNotOk(attempt: Attempt): void {
  if (!attempt.ok) {
    throw new Error(
      `Kiro ${attempt.failure}: ${attempt.error?.slice(0, 300) ?? "failed"}`,
    );
  }
}

/** Parses `kiro-cli chat --list-models --format json`. */
export function parseModelList(stdout: string) {
  const data = JSON.parse(stdout) as {
    models?: Record<string, unknown>[];
    default_model?: string;
  };
  if (!Array.isArray(data.models)) {
    throw new Error("kiro-cli --list-models returned no models array");
  }
  const s = (v: unknown) => typeof v === "string" ? v : null;
  const n = (v: unknown) => typeof v === "number" ? v : null;
  return {
    defaultModel: s(data.default_model),
    models: data.models.map((m) => ({
      id: s(m.model_id) ?? "",
      name: s(m.model_name) ?? s(m.model_id) ?? "",
      description: s(m.description) ?? "",
      contextWindowTokens: n(m.context_window_tokens),
      rateMultiplier: n(m.rate_multiplier),
      rateUnit: s(m.rate_unit),
    })).filter((m) => m.id),
  };
}

const lifetime = "30d" as const;

/** Kiro CLI agent model. */
export const model = {
  type: "@cachehit/agents/kiro",
  version: "2026.10.26.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    invocation: {
      description:
        "One Kiro run: model, success, failure class, credits, duration, tool calls, answer preview",
      schema: InvocationSchema,
      lifetime,
      garbageCollection: 100,
    },
    transcript: {
      description: "Full prompt and answer of an invocation",
      schema: TranscriptSchema,
      lifetime,
      garbageCollection: 100,
    },
    models: {
      description: "Models Kiro offers, with their credit rate multipliers",
      schema: ModelListSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
  },
  methods: {
    invoke: {
      description:
        "Run Kiro headless with a prompt and record the answer, credits and duration",
      arguments: InvokeArgsSchema,
      execute: async (args: InvokeArgs, ctx: Ctx) => {
        const { handles, attempt } = await invoke(args, ctx, false);
        failIfNotOk(attempt);
        return { dataHandles: handles };
      },
    },
    invokeAndParse: {
      description:
        "Like invoke, but the answer must contain JSON; stores it as parsed and retries when it does not",
      arguments: InvokeArgsSchema,
      execute: async (args: InvokeArgs, ctx: Ctx) => {
        const { handles, attempt } = await invoke(args, ctx, true);
        failIfNotOk(attempt);
        return { dataHandles: handles };
      },
    },
    listModels: {
      description:
        "Store the models Kiro offers with their credit rate multipliers",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, ctx: Ctx) => {
        const g = ctx.globalArgs;
        ctx.logger.info("Listing Kiro models with {path}", {
          path: g.kiroPath,
        });
        const result = await runProcess(
          g.kiroPath,
          ["chat", "--list-models", "--format", "json"],
          {
            cwd: Deno.cwd(),
            stdin: "",
            env: childEnv(Deno.env.toObject()),
            wallTimeoutMs: 60_000,
            idleTimeoutMs: 60_000,
          },
        );
        if (result.code !== 0) {
          throw new Error(
            `kiro-cli --list-models failed (exit ${result.code}): ${
              result.stderr.trim().slice(-300)
            }`,
          );
        }
        const list = parseModelList(result.stdout);
        ctx.logger.info("Kiro offers {count} models", {
          count: list.models.length,
        });
        const handle = await ctx.writeResource("models", "models", {
          ...list,
          listedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
