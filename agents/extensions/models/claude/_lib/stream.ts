/**
 * Pure parsing of `claude -p --output-format stream-json --verbose` output:
 * one JSON event per line, ending with a `result` event that carries the
 * answer, dollar cost, token counts and error state of the run.
 *
 * @module
 */
// SPDX-License-Identifier: Apache-2.0

import type { StreamSummary, Tokens } from "../../_lib/agent.ts";

type Json = Record<string, unknown>;

const obj = (value: unknown): Json | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Json
    : undefined;
const str = (value: unknown): string | null =>
  typeof value === "string" ? value : null;
const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/** What a tool call acted on, for its title: a path, pattern or command. */
function toolTitle(input: Json | undefined): string {
  if (!input) return "";
  for (const key of ["file_path", "path", "pattern", "command", "url"]) {
    const value = str(input[key]);
    if (value) return value.slice(0, 200);
  }
  return str(input.description)?.slice(0, 200) ?? "";
}

function tokensOf(usage: Json | undefined): Tokens | null {
  if (!usage) return null;
  return {
    input: num(usage.input_tokens) ?? 0,
    output: num(usage.output_tokens) ?? 0,
    cacheRead: num(usage.cache_read_input_tokens) ?? 0,
    cacheCreation: num(usage.cache_creation_input_tokens) ?? 0,
  };
}

/**
 * Reduces the event stream; lines that are not JSON are ignored. `status` is
 * `success` only when the result event reports no error, and `requests` is
 * the result's turn count. Claude Code reports no Kiro credits.
 */
export function parseStream(stdout: string): StreamSummary {
  const summary: StreamSummary = {
    sessionId: null,
    status: null,
    stopReason: null,
    text: "",
    error: null,
    credits: null,
    requests: null,
    costUsd: null,
    tokens: null,
    turnDurationMs: null,
    contextUsagePercentage: null,
    toolCalls: [],
  };
  const chunks: string[] = [];
  let result: string | null = null;
  let messageError: string | null = null;

  for (const line of stdout.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    let event: Json | undefined;
    try {
      event = obj(JSON.parse(line));
    } catch {
      continue;
    }
    if (!event) continue;
    summary.sessionId = str(event.session_id) ?? summary.sessionId;
    const content = obj(event.message)?.content;
    const blocks = Array.isArray(content) ? content.map(obj) : [];

    switch (event.type) {
      case "assistant":
        messageError = str(event.error) ?? messageError;
        for (const block of blocks) {
          if (block?.type === "text") {
            const text = str(block.text);
            if (text) chunks.push(text);
          } else if (block?.type === "tool_use" && str(block.id)) {
            summary.toolCalls.push({
              id: str(block.id)!,
              name: str(block.name) ?? "unknown",
              title: toolTitle(obj(block.input)),
              status: null,
            });
          }
        }
        break;
      case "user":
        for (const block of blocks) {
          if (block?.type !== "tool_result") continue;
          const call = summary.toolCalls.find((c) =>
            c.id === str(block.tool_use_id)
          );
          if (call) {
            call.status = block.is_error === true ? "failed" : "completed";
          }
        }
        break;
      case "result": {
        const failed = event.is_error === true;
        const subtype = str(event.subtype);
        summary.status = failed ? "error" : subtype;
        summary.stopReason = str(event.stop_reason);
        result = str(event.result);
        summary.costUsd = num(event.total_cost_usd);
        summary.tokens = tokensOf(obj(event.usage));
        summary.requests = num(event.num_turns);
        summary.turnDurationMs = num(event.duration_api_ms);
        if (failed || subtype !== "success") {
          const status = num(event.api_error_status);
          const message = result || messageError || subtype || "run failed";
          summary.error = {
            stage: subtype,
            // The status lets the classifier see 401, 403 and 429.
            message: status ? `${message} (API status ${status})` : message,
          };
        }
        break;
      }
    }
  }
  summary.text = result ?? chunks.join("");
  return summary;
}
