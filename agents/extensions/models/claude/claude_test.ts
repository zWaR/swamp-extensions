// SPDX-License-Identifier: Apache-2.0

import {
  assertAlmostEquals,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.19";
import { createModelTestContext } from "@swamp-club/swamp-testing";
import { buildArgs, model } from "./claude.ts";

type Ctx = Parameters<typeof model.methods.invoke.execute>[1];
type Written = { specName: string; data: Record<string, unknown> };

const fixture = (name: string) =>
  Deno.readTextFile(new URL(`./testdata/${name}`, import.meta.url));

const tempDirs: string[] = [];
globalThis.addEventListener("unload", () => {
  for (const dir of tempDirs) Deno.removeSync(dir, { recursive: true });
});

/** A fake claude: run n prints out<n>.jsonl, exits exit<n>, logs argv and stdin. */
async function fakeClaude(outputs: { stdout: string; exit?: number }[]) {
  const dir = await Deno.makeTempDir({ prefix: "fake-claude-" });
  tempDirs.push(dir);
  for (const [i, out] of outputs.entries()) {
    await Deno.writeTextFile(`${dir}/out${i + 1}.jsonl`, out.stdout);
    await Deno.writeTextFile(`${dir}/exit${i + 1}`, String(out.exit ?? 0));
  }
  const script = `${dir}/claude`;
  await Deno.writeTextFile(
    script,
    `#!/bin/bash
set -u
dir="$(dirname "$0")"
n=$(( $(cat "$dir/count" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$dir/count"
printf '%s\\n' "$@" > "$dir/args$n"
cat > "$dir/stdin$n"
cat "$dir/out$n.jsonl"
exit "$(cat "$dir/exit$n")"
`,
  );
  await Deno.chmod(script, 0o755);
  const read = (file: string) => Deno.readTextFile(`${dir}/${file}`);
  return { script, read };
}

function context(globalArgs: Record<string, unknown>) {
  const result = createModelTestContext({
    globalArgs: {
      defaultModel: "sonnet",
      defaultToolProfile: "readonly",
      wallTimeoutMs: 30_000,
      idleTimeoutMs: 30_000,
      maxRetries: 2,
      retryDelayMs: 0,
      ...globalArgs,
    },
  });
  return { ...result, context: result.context as unknown as Ctx };
}

const written = (list: Written[], spec: string) =>
  // deno-lint-ignore no-explicit-any
  list.find((r) => r.specName === spec)?.data as Record<string, any>;

Deno.test("buildArgs: readonly allows only read tools and no MCP servers, actor skips permissions", () => {
  assertEquals(
    buildArgs({ model: "haiku", toolProfile: "readonly", effort: null }),
    [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      "haiku",
      "--no-session-persistence",
      "--tools",
      "Read,Grep,Glob",
      "--allowedTools",
      "Read,Grep,Glob",
      "--strict-mcp-config",
      "--permission-mode",
      "dontAsk",
    ],
  );
  assertEquals(
    buildArgs({ model: "opus", toolProfile: "actor", effort: "high" }).slice(7),
    ["--dangerously-skip-permissions", "--effort", "high"],
  );
});

Deno.test("invokeAndParse sends the prompt on stdin and records cost and tokens", async () => {
  const claude = await fakeClaude([{
    stdout: await fixture("tool_call.jsonl"),
  }]);
  const { context: ctx, getWrittenResources } = context({
    claudePath: claude.script,
  });
  await model.methods.invokeAndParse.execute({
    prompt: "--looks-like-a-flag; read a.txt",
    model: "haiku",
    invocationId: "step-1",
    tags: { role: "worker" },
  }, ctx);

  assertEquals(await claude.read("stdin1"), "--looks-like-a-flag; read a.txt");
  assertStringIncludes(await claude.read("args1"), "--strict-mcp-config");
  const list = getWrittenResources() as Written[];
  const inv = written(list, "invocation");
  assertEquals(inv.success, true);
  assertEquals(inv.model, "haiku");
  assertEquals(inv.agent, null);
  assertEquals(inv.parsed, { content: "hello" });
  assertAlmostEquals(inv.costUsd, 0.0521, 0.0001);
  assertEquals(inv.tokens.output, 277);
  assertEquals(inv.credits, null);
  assertEquals(inv.requests, 2);
  assertEquals(inv.toolCalls[0].name, "Read");
  assertEquals(inv.tags, { role: "worker" });
  assertEquals(written(list, "transcript").invocationId, "step-1");
});

Deno.test("invoke stores a bad model as model-unavailable without retrying", async () => {
  const claude = await fakeClaude([
    { stdout: await fixture("model_error.jsonl"), exit: 1 },
  ]);
  const { context: ctx, getWrittenResources } = context({
    claudePath: claude.script,
  });
  await assertRejects(
    () =>
      model.methods.invoke.execute({ prompt: "hi", model: "x", tags: {} }, ctx),
    Error,
    "Claude Code model-unavailable",
  );
  const inv = written(getWrittenResources() as Written[], "invocation");
  assertEquals(inv.failureClass, "model-unavailable");
  assertEquals(inv.retries, 0);
});

Deno.test("invoke retries a rate limit and sums cost and tokens over attempts", async () => {
  const limited =
    '{"type":"result","subtype":"success","is_error":true,"api_error_status":429,"result":"API Error: Request rejected","total_cost_usd":0.01,"usage":{"input_tokens":10,"output_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}\n';
  const claude = await fakeClaude([
    { stdout: limited, exit: 1 },
    { stdout: await fixture("tool_call.jsonl") },
  ]);
  const { context: ctx, getWrittenResources } = context({
    claudePath: claude.script,
  });
  await model.methods.invoke.execute({ prompt: "hi", tags: {} }, ctx);
  const inv = written(getWrittenResources() as Written[], "invocation");
  assertEquals(inv.success, true);
  assertEquals(inv.retries, 1);
  assertEquals(inv.attempts[0].failureClass, "rate-limit");
  assertAlmostEquals(inv.costUsd, 0.0621, 0.0001);
  assertEquals(inv.tokens.input, 14);
});

Deno.test("invoke explains a missing claude", async () => {
  const { context: ctx } = context({ claudePath: "/nonexistent/claude" });
  await assertRejects(
    () => model.methods.invoke.execute({ prompt: "x", tags: {} }, ctx),
    Error,
    "claudePath",
  );
});
