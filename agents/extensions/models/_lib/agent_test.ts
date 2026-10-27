// SPDX-License-Identifier: Apache-2.0

import { assertEquals } from "jsr:@std/assert@1.0.19";
import { classifyFailure, isRetryable, parseJsonAnswer } from "./agent.ts";

Deno.test("classifyFailure and isRetryable", () => {
  const cases: [string, number, boolean, string, boolean][] = [
    ["ThrottlingException: Too many requests", 1, false, "rate-limit", true],
    ["Monthly usage limit reached", 1, false, "quota", false],
    ["You are not logged in, please log in", 1, false, "auth", false],
    ["", 0, true, "timeout", false],
    ["", 143, false, "infrastructure", true],
    ["segfault", 1, false, "infrastructure", false],
    ["", 0, false, "unknown", false],
    // Claude Code wording
    ["API Error: 429 rate_limit_error", 1, false, "rate-limit", true],
    ["Claude AI usage limit reached|1793491200", 1, false, "quota", false],
    ["You've hit your session limit · resets 3pm", 1, false, "quota", false],
    ["Invalid API key · Please run /login", 1, false, "auth", false],
    [
      "There's an issue with the selected model (x). It may not exist (API status 404)",
      1,
      false,
      "model-unavailable",
      false,
    ],
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
