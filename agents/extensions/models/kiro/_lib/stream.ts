/**
 * Pure parsing of `kiro-cli chat --output-format stream-json` output (ACP
 * events as JSON Lines), failure classification and JSON answer extraction.
 *
 * @module
 */
// SPDX-License-Identifier: Apache-2.0

/** One tool call the agent made during the run. */
export interface ToolCall {
  id: string;
  name: string;
  title: string;
  status: string | null;
}

/** Everything a run reported on stdout, reduced to the fields we record. */
export interface StreamSummary {
  engine: string | null;
  sessionId: string | null;
  /** `runFinished.status`, for example `success`; null when the run never finished. */
  status: string | null;
  stopReason: string | null;
  text: string;
  error: { stage: string | null; message: string } | null;
  /** Kiro credits metered for the turn; null when Kiro reported none. */
  credits: number | null;
  /** Model requests metered in the turn: entries in the last meteringUsage event; null when there is none. */
  requests: number | null;
  turnDurationMs: number | null;
  contextUsagePercentage: number | null;
  toolCalls: ToolCall[];
}

type Json = Record<string, unknown>;

const obj = (value: unknown): Json | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Json
    : undefined;
const str = (value: unknown): string | null =>
  typeof value === "string" ? value : null;
const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/** Reduces the JSON Lines event stream; lines that are not JSON are ignored. */
export function parseStream(stdout: string): StreamSummary {
  const summary: StreamSummary = {
    engine: null,
    sessionId: null,
    status: null,
    stopReason: null,
    text: "",
    error: null,
    credits: null,
    requests: null,
    turnDurationMs: null,
    contextUsagePercentage: null,
    toolCalls: [],
  };
  const chunks: string[] = [];
  let finalText: string | null = null;
  let finalTextTruncated = false;

  for (const line of stdout.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    let event: Json | undefined;
    try {
      event = obj(JSON.parse(line));
    } catch {
      continue;
    }
    const data = obj(event?.data);
    if (!event || !data) continue;
    summary.sessionId = str(data.sessionId) ?? summary.sessionId;

    switch (event.type) {
      case "runStarted":
        summary.engine = str(data.engine);
        break;
      case "metadata": {
        summary.contextUsagePercentage = num(data.contextUsagePercentage) ??
          summary.contextUsagePercentage;
        summary.turnDurationMs = num(data.turnDurationMs) ??
          summary.turnDurationMs;
        // Kiro sends meteringUsage once per turn (one entry per model
        // request), and a headless run is a single turn.
        if (Array.isArray(data.meteringUsage)) {
          const entries = data.meteringUsage
            .map(obj)
            .filter((m): m is Json =>
              !!m && /^credit/i.test(str(m.unit) ?? "")
            );
          summary.credits = entries.reduce(
            (total, m) => total + (num(m.value) ?? 0),
            0,
          );
          summary.requests = entries.length;
        }
        break;
      }
      case "sessionUpdate": {
        const update = obj(data.update);
        if (!update) break;
        const id = str(update.toolCallId);
        if (update.sessionUpdate === "agent_message_chunk") {
          const text = str(obj(update.content)?.text);
          if (text) chunks.push(text);
        } else if (update.sessionUpdate === "tool_call" && id) {
          summary.toolCalls.push({
            id,
            name: str(obj(obj(update._meta)?.kiro)?.toolName) ??
              str(update.kind) ?? "unknown",
            title: str(update.title) ?? "",
            status: str(update.status),
          });
        } else if (update.sessionUpdate === "tool_call_update" && id) {
          const call = summary.toolCalls.find((c) => c.id === id);
          if (call) call.status = str(update.status) ?? call.status;
        }
        break;
      }
      case "runFinished":
        summary.status = str(data.status);
        summary.stopReason = str(data.stopReason);
        finalText = str(data.finalText);
        finalTextTruncated = data.finalTextTruncated === true;
        break;
      case "runError":
        summary.error = {
          stage: str(data.stage),
          message: str(data.message) ?? "unknown error",
        };
        break;
    }
  }
  summary.text = finalText !== null && !finalTextTruncated
    ? finalText
    : chunks.join("");
  return summary;
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

/** Ordered: the first matching class wins. */
const SIGNATURES: [FailureClass, RegExp][] = [
  ["rate-limit", /throttl|rate.?limit|too many requests|\b429\b|overloaded/i],
  [
    "quota",
    /quota|usage limit|limit reached|out of credits|insufficient|payment required/i,
  ],
  [
    "auth",
    /not logged in|log ?in again|unauthori[sz]ed|authenticat|expired token|\b401\b|\b403\b/i,
  ],
  ["model-unavailable", /model .*not available|unknown model|invalid model/i],
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
