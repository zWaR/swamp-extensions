/**
 * Pure parsing of `kiro-cli chat --output-format stream-json` output (ACP
 * events as JSON Lines).
 *
 * @module
 */
// SPDX-License-Identifier: Apache-2.0

import type { StreamSummary } from "../../_lib/agent.ts";

/**
 * A Kiro run: `status` is `runFinished.status`, `requests` the entries in the
 * last meteringUsage event, and there are no token counts or dollar cost.
 */
export interface KiroStreamSummary extends StreamSummary {
  engine: string | null;
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
export function parseStream(stdout: string): KiroStreamSummary {
  const summary: KiroStreamSummary = {
    engine: null,
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
