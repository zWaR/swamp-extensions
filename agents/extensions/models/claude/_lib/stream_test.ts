// SPDX-License-Identifier: Apache-2.0

import { assertAlmostEquals, assertEquals } from "jsr:@std/assert@1.0.19";
import { classifyFailure } from "../../_lib/agent.ts";
import { parseStream } from "./stream.ts";

const fixture = (name: string) =>
  Deno.readTextFile(new URL(`../testdata/${name}`, import.meta.url));

Deno.test("parseStream reads the answer, cost, tokens and tool calls of a run", async () => {
  const s = parseStream(await fixture("tool_call.jsonl"));
  assertEquals(s.sessionId, "5ad776ff-0696-4d4c-9212-ec0230192ee1");
  assertEquals(s.status, "success");
  assertEquals(s.stopReason, "end_turn");
  assertEquals(s.text, '```json\n{"content": "hello"}\n```');
  assertEquals(s.error, null);
  assertAlmostEquals(s.costUsd!, 0.0521, 0.0001);
  assertEquals(s.tokens, {
    input: 4,
    output: 277,
    cacheRead: 73296,
    cacheCreation: 109229,
  });
  assertEquals(s.requests, 2);
  assertEquals(s.credits, null);
  assertEquals(s.toolCalls, [{
    id: "toolu_017ntUdjQZWpD9Xkfd71fp2a",
    name: "Read",
    title: "/work/repo/a.txt",
    status: "completed",
  }]);
});

Deno.test("parseStream turns an is_error result into a classified error", async () => {
  const s = parseStream(await fixture("model_error.jsonl"));
  assertEquals(s.status, "error");
  assertEquals(s.error?.stage, "success");
  assertEquals(
    classifyFailure(s.error!.message, 1, false),
    "model-unavailable",
  );
});

Deno.test("parseStream adds the API status and falls back to message text", () => {
  const lines = [
    "not json",
    '{"type":"assistant","message":{"content":[{"type":"text","text":"partial "}]}}',
    '{"type":"assistant","message":{"content":[{"type":"text","text":"answer"}]}}',
  ];
  assertEquals(parseStream(lines.join("\n")).text, "partial answer");
  const limited = parseStream(
    '{"type":"result","subtype":"success","is_error":true,"api_error_status":429,"result":"API Error"}',
  );
  assertEquals(limited.error?.message, "API Error (API status 429)");
  assertEquals(classifyFailure(limited.error!.message, 1, false), "rate-limit");
  assertEquals(
    parseStream(
      '{"type":"result","subtype":"error_max_turns","is_error":false}',
    )
      .error?.message,
    "error_max_turns",
  );
});
