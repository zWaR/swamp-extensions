// SPDX-License-Identifier: Apache-2.0

import { assertAlmostEquals, assertEquals } from "jsr:@std/assert@1.0.19";
import {
  classifyFailure,
  isRetryable,
  parseJsonAnswer,
  parseStream,
} from "./stream.ts";

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
  assertEquals(s.turnDurationMs, 1764);
  assertEquals(s.toolCalls, []);
});

Deno.test("parseStream sums credits per request and records tool calls", async () => {
  const s = parseStream(await fixture("tool_call.jsonl"));
  assertAlmostEquals(s.credits!, 0.0326 + 0.0280, 0.0001);
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

Deno.test("classifyFailure and isRetryable", () => {
  const cases: [string, number, boolean, string, boolean][] = [
    ["ThrottlingException: Too many requests", 1, false, "rate-limit", true],
    ["Monthly usage limit reached", 1, false, "quota", false],
    ["You are not logged in, please log in", 1, false, "auth", false],
    ["", 0, true, "timeout", false],
    ["", 143, false, "infrastructure", true],
    ["segfault", 1, false, "infrastructure", false],
    ["", 0, false, "unknown", false],
  ];
  for (const [message, code, timedOut, failure, retry] of cases) {
    const got = classifyFailure(message, code, timedOut);
    assertEquals(got, failure, message);
    assertEquals(isRetryable(got, code), retry, message);
  }
});

Deno.test("parseJsonAnswer finds fenced, bare and nested JSON", () => {
  assertEquals(parseJsonAnswer('```json\n{"ok":true}\n```'), { ok: true });
  assertEquals(
    parseJsonAnswer('Plan: {"tasks":[{"id":1,"note":"a } brace"}]} done'),
    { tasks: [{ id: 1, note: "a } brace" }] },
  );
  assertEquals(parseJsonAnswer("[1, 2]"), [1, 2]);
  assertEquals(parseJsonAnswer('use {braces} wisely, then {"a":1}'), {
    a: 1,
  });
  assertEquals(parseJsonAnswer("no json here"), null);
});
