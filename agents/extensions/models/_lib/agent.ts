/**
 * What every agent CLI model shares: argument and record schemas, failure
 * classification, JSON answer extraction and the retrying invoke loop. Each
 * model supplies its command line and a parser for its output stream.
 *
 * @module
 */
// SPDX-License-Identifier: Apache-2.0

import { z } from "npm:zod@4.6.5";
import { childEnv, type ProcessResult, runProcess } from "./process.ts";

/** One tool call the agent made during the run. */
export interface ToolCall {
  id: string;
  name: string;
  title: string;
  status: string | null;
}

/** Token counts of a run, summed over its model requests. */
export interface Tokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

/** Everything a run reported on stdout, reduced to the fields we record. */
export interface StreamSummary {
  sessionId: string | null;
  /** `success` when the run finished without error; null when it never finished. */
  status: string | null;
  stopReason: string | null;
  text: string;
  error: { stage: string | null; message: string } | null;
  /** Kiro credits metered for the run; null when the CLI reported none. */
  credits: number | null;
  /** Model requests in the run; null when the CLI reported none. */
  requests: number | null;
  /** Cost in US dollars the CLI reported; null when it reported none. */
  costUsd: number | null;
  tokens: Tokens | null;
  turnDurationMs: number | null;
  contextUsagePercentage: number | null;
  toolCalls: ToolCall[];
}

/** Why an invocation failed. */
export const FAILURE_CLASSES = [
  "rate-limit",
  "quota",
  "auth",
  "model-unavailable",
  "timeout",
  "contract-violation",
  "infrastructure",
  "unknown",
] as const;
export type FailureClass = typeof FAILURE_CLASSES[number];

/** Exit codes of a process killed by SIGKILL or SIGTERM from outside. */
const TRANSIENT_EXIT_CODES = new Set([137, 143]);

/** Ordered: the first matching class wins. Covers Kiro and Claude Code wording. */
const SIGNATURES: [FailureClass, RegExp][] = [
  ["rate-limit", /throttl|rate.?limit|too many requests|\b429\b|overloaded/i],
  [
    "quota",
    /quota|usage limit|limit reached|hit your .*limit|out of credits|insufficient|payment required/i,
  ],
  [
    "auth",
    /not logged in|log ?in again|run \/login|invalid api key|unauthori[sz]ed|authenticat|expired token|token has expired|\b401\b|\b403\b/i,
  ],
  [
    "model-unavailable",
    /model .*not available|unknown model|invalid model|selected model|model_not_found/i,
  ],
];

/** Classifies a failed run from its error message, exit code and timeout. */
export function classifyFailure(
  message: string,
  exitCode: number,
  timedOut: boolean,
): FailureClass {
  if (timedOut) return "timeout";
  const match = SIGNATURES.find(([, re]) => re.test(message));
  if (match) return match[0];
  return exitCode !== 0 ? "infrastructure" : "unknown";
}

/** Whether a failed attempt is worth repeating unchanged. */
export function isRetryable(
  failure: FailureClass,
  exitCode: number,
): boolean {
  return failure === "rate-limit" ||
    (failure === "infrastructure" && TRANSIENT_EXIT_CODES.has(exitCode));
}

/**
 * The first JSON object or array in an answer: inside a fenced code block if
 * there is one, otherwise the first balanced `{...}` or `[...]`.
 */
export function parseJsonAnswer(text: string): unknown | null {
  const fenced = text.match(/```(?:json)?[ \t]*\n?([\s\S]*?)```/);
  const sources = fenced ? [fenced[1], text] : [text];
  for (const source of sources) {
    for (let start = 0; start < source.length; start++) {
      if (source[start] !== "{" && source[start] !== "[") continue;
      const end = balancedEnd(source, start);
      if (end === -1) continue;
      try {
        return JSON.parse(source.slice(start, end));
      } catch {
        // Not JSON after all (prose with braces); keep scanning.
      }
    }
  }
  return null;
}

/** Index just past the bracket matching `source[start]`, or -1. */
function balancedEnd(source: string, start: number): number {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i++) {
    const c = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{") stack.push("}");
    else if (c === "[") stack.push("]");
    else if (c === "}" || c === "]") {
      if (stack.pop() !== c) return -1;
      if (stack.length === 0) return i + 1;
    }
  }
  return -1;
}

export const ToolProfileSchema = z.enum(["readonly", "actor"]);
export type ToolProfile = z.infer<typeof ToolProfileSchema>;
export const EffortSchema = z.enum(["low", "medium", "high", "xhigh", "max"]);
const TimeoutSchema = z.number().int().min(1_000).max(21_600_000);

/** Global arguments every agent model takes. */
export const commonGlobalArgs = {
  defaultToolProfile: ToolProfileSchema.default("readonly").describe(
    "readonly: read and search files only; actor: every tool of the agent, trusted without prompts",
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
};

/** Invoke arguments every agent model takes, besides `model`. */
export const commonInvokeArgs = {
  prompt: z.string().min(1).describe("Task for the agent; sent on stdin"),
  toolProfile: ToolProfileSchema.optional().describe(
    "Overrides defaultToolProfile",
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
};

const TokensSchema = z.object({
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheCreation: z.number(),
});

export const InvocationSchema = z.object({
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
  requests: z.number().nullable(),
  costUsd: z.number().nullable(),
  tokens: TokensSchema.nullable(),
  attempts: z.array(z.object({
    attempt: z.number(),
    exitCode: z.number(),
    failureClass: z.enum(FAILURE_CLASSES).nullable(),
    error: z.string().nullable(),
    credits: z.number().nullable(),
    requests: z.number().nullable(),
    costUsd: z.number().nullable(),
    tokens: TokensSchema.nullable(),
    durationMs: z.number(),
  })),
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

export const TranscriptSchema = z.object({
  invocationId: z.string(),
  prompt: z.string(),
  output: z.string(),
  stderrTail: z.string(),
});

export type Handle = Record<string, unknown>;
type Logger = (message: string, fields?: Record<string, unknown>) => void;
export type Ctx<G> = {
  globalArgs: G;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<Handle>;
  logger: { info: Logger; warning: Logger };
};
const CommonGlobalArgsSchema = z.object(commonGlobalArgs);
type CommonGlobalArgs = z.infer<typeof CommonGlobalArgsSchema>;
const CommonInvokeArgsSchema = z.object(commonInvokeArgs);
type CommonInvokeArgs = z.infer<typeof CommonInvokeArgsSchema>;

/** How one agent CLI runs: its command line, stream parser and setup. */
export interface AgentRun {
  /** Name in logs and errors, for example `Kiro`. */
  label: string;
  command: string;
  /** Global argument that sets `command`. */
  pathArg: string;
  cliArgs: string[];
  parse: (stdout: string) => StreamSummary;
  model: string;
  toolProfile: ToolProfile;
  agent: string | null;
  /** Runs once before the first attempt, with the child environment. */
  prepare?: (env: Record<string, string>) => Promise<void>;
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

export interface Attempt {
  process: ProcessResult;
  stream: StreamSummary;
  ok: boolean;
  failure: FailureClass | null;
  error: string | null;
  parsed: unknown | null;
}

/** Judges one finished process run. */
function judge(
  process: ProcessResult,
  stream: StreamSummary,
  requireJson: boolean,
): Attempt {
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

/** Sum of the non-null values; null when every value is null. */
const sumOrNull = (values: (number | null)[]): number | null =>
  values.some((v) => v !== null)
    ? values.reduce<number>((total, v) => total + (v ?? 0), 0)
    : null;

/** Token counts summed over the attempts that reported any; null when none did. */
function sumTokens(values: (Tokens | null)[]): Tokens | null {
  const reported = values.filter((t): t is Tokens => t !== null);
  if (reported.length === 0) return null;
  return reported.reduce((a, t) => ({
    input: a.input + t.input,
    output: a.output + t.output,
    cacheRead: a.cacheRead + t.cacheRead,
    cacheCreation: a.cacheCreation + t.cacheCreation,
  }));
}

/**
 * Runs the agent CLI, retrying rate limits, killed processes and (optionally)
 * non-JSON answers, and stores the invocation and transcript records.
 */
export async function runAgent(
  run: AgentRun,
  args: CommonInvokeArgs,
  ctx: Ctx<CommonGlobalArgs>,
  requireJson: boolean,
): Promise<{ handles: Handle[]; attempt: Attempt }> {
  const g = ctx.globalArgs;
  const { model, toolProfile } = run;
  const effort = args.effort ?? null;
  const cwd = args.cwd ?? Deno.cwd();
  const cwdInfo = await Deno.stat(cwd).catch(() => null);
  if (!cwdInfo?.isDirectory) {
    throw new Error(`cwd ${cwd} is not an existing directory`);
  }
  const invocationId = args.invocationId ?? crypto.randomUUID();
  const env = childEnv(Deno.env.toObject());
  await run.prepare?.(env);
  ctx.logger.info(`Running ${run.label} {model} ({profile}) in {cwd} as {id}`, {
    model,
    profile: toolProfile,
    cwd,
    id: invocationId,
  });

  const startedAt = new Date();
  let prompt = args.prompt;
  let retries = 0;
  let attempt: Attempt;
  const attempts: {
    attempt: number;
    exitCode: number;
    failureClass: FailureClass | null;
    error: string | null;
    credits: number | null;
    requests: number | null;
    costUsd: number | null;
    tokens: Tokens | null;
    durationMs: number;
  }[] = [];
  while (true) {
    const process = await runProcess(run.command, run.cliArgs, {
      cwd,
      stdin: prompt,
      env,
      wallTimeoutMs: args.wallTimeoutMs ?? g.wallTimeoutMs,
      idleTimeoutMs: args.idleTimeoutMs ?? g.idleTimeoutMs,
      pathArg: run.pathArg,
    });
    attempt = judge(process, run.parse(process.stdout), requireJson);
    attempts.push({
      attempt: attempts.length + 1,
      exitCode: process.code,
      failureClass: attempt.failure,
      error: attempt.error,
      credits: attempt.stream.credits,
      requests: attempt.stream.requests,
      costUsd: attempt.stream.costUsd,
      tokens: attempt.stream.tokens,
      durationMs: process.durationMs,
    });
    const retry = !attempt.ok && retries < g.maxRetries &&
      (attempt.failure === "contract-violation" ||
        isRetryable(attempt.failure!, process.code));
    if (!retry) break;
    retries++;
    ctx.logger.warning(`${run.label} {failure}, retrying ({n}/{max})`, {
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
  const credits = sumOrNull(attempts.map((a) => a.credits));
  const costUsd = sumOrNull(attempts.map((a) => a.costUsd));
  const invocation = await ctx.writeResource(
    "invocation",
    `invocation-${invocationId}`,
    {
      invocationId,
      model,
      toolProfile,
      agent: run.agent,
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
      credits,
      requests: sumOrNull(attempts.map((a) => a.requests)),
      costUsd,
      tokens: sumTokens(attempts.map((a) => a.tokens)),
      attempts,
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
    `${run.label} {model}: {status} in {ms}ms, {credits} credits, \${cost}, {tools} tool calls, {retries} retries`,
    {
      model,
      status: attempt.ok ? "ok" : attempt.failure,
      ms: process.durationMs,
      credits: credits ?? "no",
      cost: costUsd ?? "unknown",
      tools: stream.toolCalls.length,
      retries,
    },
  );
  return { handles: [invocation, transcript], attempt };
}

/** Throws after the records are stored, so a workflow step fails visibly. */
export function failIfNotOk(label: string, attempt: Attempt): void {
  if (!attempt.ok) {
    throw new Error(
      `${label} ${attempt.failure}: ${
        attempt.error?.slice(0, 300) ?? "failed"
      }`,
    );
  }
}
