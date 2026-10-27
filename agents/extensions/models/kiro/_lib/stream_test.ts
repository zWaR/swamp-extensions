// SPDX-License-Identifier: Apache-2.0

import { assertAlmostEquals, assertEquals } from "jsr:@std/assert@1.0.19";
import { classifyFailure } from "../../_lib/agent.ts";
import { parseStream } from "./stream.ts";

const fixture = (name: string) =>
  Deno.readTextFile(new URL(`../testdata/${name}`, import.meta.url));

Deno.test("parseStream reads the final text, session and credits of a run", async () => {
  const s = parseStream(await fixture("success_json.jsonl"));
  assertEquals(s.engine, "v2");
  assertEquals(s.sessionId, "a9218a94-a838-455b-8f4c-4166b17e4895");
  assertEquals(s.status, "success");
  assertEquals(s.stopReason, "end_turn");
  assertEquals(s.text, '```json\n{"ok":true}\n```');
  assertEquals(s.error, null);
  assertAlmostEquals(s.credits!, 0.0506, 0.0001);
  assertEquals(s.requests, 1);
  assertEquals(s.turnDurationMs, 1764);
  assertEquals(s.toolCalls, []);
});

Deno.test("parseStream sums credits per request and records tool calls", async () => {
  const s = parseStream(await fixture("tool_call.jsonl"));
  assertAlmostEquals(s.credits!, 0.0326 + 0.0280, 0.0001);
  assertEquals(s.requests, 2);
  assertEquals(s.toolCalls, [{
    id: "tooluse_T7wJUBEPU9GIhsxROJLtYA",
    name: "shell",
    title: "Running: cat f.txt",
    status: "completed",
  }]);
});

Deno.test("parseStream reports a runError and no finished status", async () => {
  const s = parseStream(await fixture("model_error.jsonl"));
  assertEquals(s.status, null);
  assertEquals(s.credits, null);
  assertEquals(s.requests, null);
  assertEquals(s.error?.stage, "prompt");
  assertEquals(
    classifyFailure(s.error!.message, 1, false),
    "model-unavailable",
  );
});

Deno.test("parseStream falls back to message chunks when finalText is truncated", () => {
  const lines = [
    "not json",
    '{"type":"sessionUpdate","data":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"full "}}}}',
    '{"type":"sessionUpdate","data":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"answer"}}}}',
    '{"type":"runFinished","data":{"status":"success","finalText":"fu","finalTextTruncated":true}}',
  ];
  assertEquals(parseStream(lines.join("\n")).text, "full answer");
});
