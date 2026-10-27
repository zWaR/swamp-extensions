// SPDX-License-Identifier: Apache-2.0

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.19";
import { createModelTestContext } from "@swamp-club/swamp-testing";
import {
  buildChatArgs,
  model,
  parseModelList,
  READONLY_AGENT_NAME,
  readonlyAgentConfig,
} from "./kiro.ts";
import { childEnv } from "./_lib/process.ts";

type Ctx = Parameters<typeof model.methods.invoke.execute>[1];
type Written = { specName: string; data: Record<string, unknown> };

const fixture = (name: string) =>
  Deno.readTextFile(new URL(`./testdata/${name}`, import.meta.url));

const tempDirs: string[] = [];
globalThis.addEventListener("unload", () => {
  for (const dir of tempDirs) Deno.removeSync(dir, { recursive: true });
});
async function tempDir(prefix: string): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix });
  tempDirs.push(dir);
  return dir;
}

/**
 * A fake kiro-cli in a temp dir. Run n prints out<n>.jsonl and exits with
 * exit<n> (default 0); it logs its argv and stdin, and sleeps when told to.
 */
async function fakeKiro(outputs: { stdout: string; exit?: number }[]) {
  const dir = await tempDir("fake-kiro-");
  for (const [i, out] of outputs.entries()) {
    await Deno.writeTextFile(`${dir}/out${i + 1}.jsonl`, out.stdout);
    await Deno.writeTextFile(`${dir}/exit${i + 1}`, String(out.exit ?? 0));
  }
  const script = `${dir}/kiro-cli`;
  await Deno.writeTextFile(
    script,
    `#!/bin/bash
set -u
dir="$(dirname "$0")"
n=$(( $(cat "$dir/count" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$dir/count"
printf '%s\\n' "$@" > "$dir/args$n"
cat > "$dir/stdin$n"
env > "$dir/env$n"
if [[ -f "$dir/sleep" ]]; then sleep "$(cat "$dir/sleep")"; fi
cat "$dir/out$n.jsonl"
exit "$(cat "$dir/exit$n")"
`,
  );
  await Deno.chmod(script, 0o755);
  const read = (file: string) => Deno.readTextFile(`${dir}/${file}`);
  return { dir, script, read };
}

function context(globalArgs: Record<string, unknown>) {
  const result = createModelTestContext({
    globalArgs: {
      defaultModel: "auto",
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

/** Runs `fn` with HOME pointed at a temp dir. */
async function withHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const old = Deno.env.get("HOME");
  const home = await tempDir("kiro-home-");
  Deno.env.set("HOME", home);
  try {
    return await fn(home);
  } finally {
    if (old === undefined) Deno.env.delete("HOME");
    else Deno.env.set("HOME", old);
  }
}

Deno.test("buildChatArgs: readonly uses the read-only agent, actor trusts all tools", () => {
  assertEquals(
    buildChatArgs({
      model: "claude-haiku-4.5",
      toolProfile: "readonly",
      agent: null,
      effort: null,
    }),
    [
      "chat",
      "--model",
      "claude-haiku-4.5",
      "--output-format",
      "stream-json",
      "--agent",
      READONLY_AGENT_NAME,
      "--trust-tools=read,grep,glob",
    ],
  );
  assertEquals(
    buildChatArgs({
      model: "auto",
      toolProfile: "actor",
      agent: "dev",
      effort: "high",
    }).slice(5),
    ["--agent", "dev", "--trust-all-tools", "--effort", "high"],
  );
});

Deno.test("invoke sends the prompt on stdin and records the run", async () => {
  await withHome(async (home) => {
    const kiro = await fakeKiro([{ stdout: await fixture("tool_call.jsonl") }]);
    Deno.env.set("SWAMP_API_KEY", "secret-swamp-key");
    try {
      const { context: ctx, getWrittenResources } = context({
        kiroPath: kiro.script,
      });
      await model.methods.invoke.execute({
        prompt: "--looks-like-a-flag; cat f.txt",
        model: "claude-haiku-4.5",
        invocationId: "step-1",
        tags: { role: "worker" },
      }, ctx);

      assertEquals(await kiro.read("stdin1"), "--looks-like-a-flag; cat f.txt");
      assertStringIncludes(await kiro.read("args1"), READONLY_AGENT_NAME);
      assertEquals((await kiro.read("env1")).includes("SWAMP_API_KEY"), false);
      assertEquals(
        await Deno.readTextFile(
          `${home}/.kiro/agents/${READONLY_AGENT_NAME}.json`,
        ),
        readonlyAgentConfig(),
      );

      const list = getWrittenResources() as Written[];
      const inv = written(list, "invocation");
      assertEquals(inv.invocationId, "step-1");
      assertEquals(inv.success, true);
      assertEquals(inv.failureClass, null);
      assertEquals(inv.model, "claude-haiku-4.5");
      assertEquals(inv.toolProfile, "readonly");
      assertEquals(inv.retries, 0);
      assertEquals(inv.toolCalls[0].name, "shell");
      assert(inv.credits > 0.06 && inv.credits < 0.061);
      assertEquals(inv.requests, 2);
      assertEquals(inv.attempts.length, 1);
      assertEquals(inv.tags, { role: "worker" });
      assertEquals("parsed" in inv, false);
      assertEquals(
        written(list, "transcript").output,
        "I'll run that command for you.The file contains:\n\n```\nhello\n```",
      );
    } finally {
      Deno.env.delete("SWAMP_API_KEY");
    }
  });
});

Deno.test("invoke stores the failure, then throws, without retrying a bad model", async () => {
  await withHome(async () => {
    const kiro = await fakeKiro([
      { stdout: await fixture("model_error.jsonl"), exit: 1 },
    ]);
    const { context: ctx, getWrittenResources } = context({
      kiroPath: kiro.script,
    });
    await assertRejects(
      () =>
        model.methods.invoke.execute({
          prompt: "hi",
          model: "no-such-model",
          tags: {},
        }, ctx),
      Error,
      "model-unavailable",
    );
    const inv = written(getWrittenResources() as Written[], "invocation");
    assertEquals(inv.success, false);
    assertEquals(inv.failureClass, "model-unavailable");
    assertEquals(inv.exitCode, 1);
    assertEquals(inv.retries, 0);
  });
});

Deno.test("invoke retries a rate limit and succeeds", async () => {
  await withHome(async () => {
    const throttled =
      '{"type":"runError","data":{"stage":"prompt","message":"ThrottlingException: rate exceeded"}}\n';
    const kiro = await fakeKiro([
      { stdout: throttled, exit: 1 },
      { stdout: await fixture("success_json.jsonl") },
    ]);
    const { context: ctx, getWrittenResources } = context({
      kiroPath: kiro.script,
    });
    await model.methods.invoke.execute({ prompt: "hi", tags: {} }, ctx);
    const inv = written(getWrittenResources() as Written[], "invocation");
    assertEquals(inv.success, true);
    assertEquals(inv.retries, 1);
    // success_json.jsonl meters one request of 0.05059837883913765 credits.
    const credits = 0.05059837883913765;
    assertEquals(inv.attempts.length, 2);
    assertEquals(inv.attempts[0].attempt, 1);
    assertEquals(inv.attempts[0].exitCode, 1);
    assertEquals(inv.attempts[0].failureClass, "rate-limit");
    assertEquals(inv.attempts[0].credits, null);
    assertEquals(inv.attempts[1].attempt, 2);
    assertEquals(inv.attempts[1].exitCode, 0);
    assertEquals(inv.attempts[1].failureClass, null);
    assertEquals(inv.attempts[1].credits, credits);
    assertEquals(inv.credits, credits);
    assertEquals(inv.requests, 1);
  });
});

Deno.test("invokeAndParse stores the JSON and re-asks once when the answer has none", async () => {
  await withHome(async () => {
    const prose =
      '{"type":"runFinished","data":{"status":"success","stopReason":"end_turn","finalText":"Sure, all good."}}\n';
    const kiro = await fakeKiro([
      { stdout: prose },
      { stdout: await fixture("success_json.jsonl") },
    ]);
    const { context: ctx, getWrittenResources } = context({
      kiroPath: kiro.script,
    });
    await model.methods.invokeAndParse.execute(
      { prompt: "Return JSON", tags: {} },
      ctx,
    );
    assertStringIncludes(await kiro.read("stdin2"), "contained no valid JSON");
    const inv = written(getWrittenResources() as Written[], "invocation");
    assertEquals(inv.parsed, { ok: true });
    assertEquals(inv.retries, 1);
  });
});

Deno.test("invokeAndParse fails as contract-violation when retries run out", async () => {
  await withHome(async () => {
    const prose =
      '{"type":"runFinished","data":{"status":"success","finalText":"no json"}}\n';
    const kiro = await fakeKiro([{ stdout: prose }]);
    const { context: ctx, getWrittenResources } = context({
      kiroPath: kiro.script,
      maxRetries: 0,
    });
    await assertRejects(
      () =>
        model.methods.invokeAndParse.execute({ prompt: "x", tags: {} }, ctx),
      Error,
      "contract-violation",
    );
    const inv = written(getWrittenResources() as Written[], "invocation");
    assertEquals(inv.parsed, null);
    assertEquals(inv.failureClass, "contract-violation");
  });
});

Deno.test("invoke kills a run that goes quiet", async () => {
  await withHome(async () => {
    const kiro = await fakeKiro([{ stdout: "" }]);
    await Deno.writeTextFile(`${kiro.dir}/sleep`, "30");
    const { context: ctx, getWrittenResources } = context({
      kiroPath: kiro.script,
      maxRetries: 0,
    });
    await assertRejects(
      () =>
        model.methods.invoke.execute({
          prompt: "x",
          idleTimeoutMs: 1_000,
          tags: {},
        }, ctx),
      Error,
      "timeout",
    );
    const inv = written(getWrittenResources() as Written[], "invocation");
    assertEquals(inv.failureClass, "timeout");
    assert(inv.durationMs < 10_000);
  });
});

Deno.test("invoke rejects an agent with the readonly profile", async () => {
  const { context: ctx } = context({ kiroPath: "/nonexistent" });
  await assertRejects(
    () =>
      model.methods.invoke.execute(
        { prompt: "x", agent: "dev", tags: {} },
        ctx,
      ),
    Error,
    "toolProfile actor",
  );
});

Deno.test("invoke rejects a cwd that does not exist", async () => {
  await withHome(async () => {
    const kiro = await fakeKiro([{ stdout: "" }]);
    const { context: ctx } = context({ kiroPath: kiro.script });
    await assertRejects(
      () =>
        model.methods.invoke.execute(
          { prompt: "x", cwd: "/nonexistent/dir", tags: {} },
          ctx,
        ),
      Error,
      "not an existing directory",
    );
  });
});

Deno.test("invoke explains a missing kiro-cli", async () => {
  await withHome(async () => {
    const { context: ctx } = context({ kiroPath: "/nonexistent/kiro-cli" });
    await assertRejects(
      () => model.methods.invoke.execute({ prompt: "x", tags: {} }, ctx),
      Error,
      "not found",
    );
  });
});

Deno.test("listModels stores models with rate multipliers", async () => {
  const stdout = JSON.stringify({
    default_model: "auto",
    models: [
      {
        model_id: "claude-haiku-4.5",
        model_name: "claude-haiku-4.5",
        description: "Haiku",
        context_window_tokens: 200000,
        rate_multiplier: 0.4,
        rate_unit: "Credit",
      },
      { model_name: "no id" },
    ],
  });
  const kiro = await fakeKiro([{ stdout }]);
  const { context: ctx, getWrittenResources } = context({
    kiroPath: kiro.script,
  });
  await model.methods.listModels.execute({}, ctx);
  assertStringIncludes(await kiro.read("args1"), "--list-models");
  const models = written(getWrittenResources() as Written[], "models");
  assertEquals(models.defaultModel, "auto");
  assertEquals(models.models, [{
    id: "claude-haiku-4.5",
    name: "claude-haiku-4.5",
    description: "Haiku",
    contextWindowTokens: 200000,
    rateMultiplier: 0.4,
    rateUnit: "Credit",
  }]);
});

Deno.test("parseModelList rejects unexpected output", () => {
  let error: unknown;
  try {
    parseModelList('{"something":"else"}');
  } catch (e) {
    error = e;
  }
  assert(error instanceof Error);
});

Deno.test("childEnv drops swamp credentials and keeps the rest", () => {
  assertEquals(
    childEnv({
      PATH: "/bin",
      SWAMP_API_KEY: "x",
      SWAMP_FUTURE_TOKEN: "y",
      SWAMP_REPO_DIR: "/repo",
    }),
    { PATH: "/bin", SWAMP_REPO_DIR: "/repo" },
  );
});
