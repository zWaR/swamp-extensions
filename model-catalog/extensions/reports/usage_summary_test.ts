// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.19";
import { createReportTestContext } from "@swamp-club/swamp-testing";
import { formatDuration, report } from "./usage_summary.ts";

const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));

function invocation(over: Record<string, unknown>) {
  return {
    invocationId: "x",
    startedAt: "2026-10-27T10:00:00.000Z",
    finishedAt: "2026-10-27T10:01:00.000Z",
    success: true,
    credits: null,
    costUsd: null,
    tokens: null,
    durationMs: 60_000,
    model: "m",
    tags: {},
    attempts: [{}],
    ...over,
  };
}

/** One step per entry, each writing one invocation record. */
function context(
  steps: { type: string; step: string; attrs?: unknown }[],
  globalArgs: Record<string, unknown> = {},
) {
  const handle = (name: string) => ({
    name,
    specName: "invocation",
    kind: "resource" as const,
    dataId: name,
    version: 1,
    size: 1,
    tags: {},
    metadata: {
      contentType: "application/json",
      lifetime: "30d",
      garbageCollection: 5,
      streaming: false,
      tags: {},
      ownerDefinition: {
        ownerType: "workflow-step" as const,
        ownerRef: "invoke",
      },
    },
  });
  return createReportTestContext({
    scope: "workflow",
    workflowName: "orchestrate",
    workflowRunId: "run-1",
    workflowStatus: "succeeded",
    stepExecutions: steps.map((s) => ({
      jobName: "main",
      stepName: s.step,
      taskType: "model",
      modelName: s.step,
      modelType: s.type,
      methodName: "invoke",
      status: "succeeded",
      dataHandles: s.attrs ? [handle(`invocation-${s.step}`)] : [],
      methodArgs: {},
      modelId: `id-${s.step}`,
      globalArgs,
    })),
    dataArtifacts: steps.filter((s) => s.attrs).map((s) => ({
      modelType: s.type,
      modelId: `id-${s.step}`,
      data: {
        name: `invocation-${s.step}`,
        kind: "resource" as const,
        dataId: `invocation-${s.step}`,
        version: 1,
        size: 1,
        contentType: "application/json",
      },
      content: enc(s.attrs),
    })),
  }).context;
}

Deno.test("sums orchestrator and Kiro and Claude workers per role", async () => {
  const ctx = context([
    { type: "@cachehit/model-catalog", step: "dispatch" },
    {
      type: "@cachehit/agents/claude",
      step: "plan",
      attrs: invocation({
        model: "opus",
        costUsd: 0.5,
        tokens: { input: 10, output: 20, cacheRead: 3, cacheCreation: 2 },
        tags: { role: "orchestrator" },
        startedAt: "2026-10-27T10:00:00.000Z",
        finishedAt: "2026-10-27T10:01:00.000Z",
      }),
    },
    {
      type: "@cachehit/agents/kiro",
      step: "work-a",
      attrs: invocation({
        model: "claude-haiku-4.5",
        credits: 0.4,
        tags: { role: "worker" },
        startedAt: "2026-10-27T10:01:00.000Z",
        finishedAt: "2026-10-27T10:03:00.000Z",
        durationMs: 120_000,
        attempts: [{}, {}],
      }),
    },
    {
      type: "@cachehit/agents/kiro",
      step: "work-b",
      // No role tag and no finishedAt, as an older or untagged run.
      attrs: invocation({
        credits: 0.6,
        success: false,
        finishedAt: undefined,
        startedAt: "2026-10-27T10:01:30.000Z",
      }),
    },
    { type: "@cachehit/agents/kiro", step: "skipped" },
  ], { roleMap: { "work-b": "worker" } });

  // deno-lint-ignore no-explicit-any
  const { json, markdown } = await report.execute(ctx as any);
  // deno-lint-ignore no-explicit-any
  const byRole = json.byRole as any;
  assertEquals(byRole.orchestrator.costUsd, 0.5);
  assertEquals(byRole.orchestrator.tokens.output, 20);
  assertEquals(byRole.orchestrator.wallMs, 60_000);
  assertEquals(byRole.worker.invocations, 2);
  assertEquals(byRole.worker.credits, 1);
  assertEquals(byRole.worker.failed, 1);
  assertEquals(byRole.worker.retries, 1);
  assertEquals(byRole.worker.durationMs, 180_000);
  assertEquals(byRole.worker.wallMs, 120_000);
  assertEquals(json.wallMs, 180_000);
  assertStringIncludes(
    markdown,
    "| orchestrator | 1 | 0 | — | $0.5000 | 10 / 20 / 5 |",
  );
  assertStringIncludes(
    markdown,
    "| worker | main/work-a | kiro | claude-haiku-4.5 | ok | 0.4 | — | — | 2m 0s | 1 |",
  );
});

Deno.test("a workflow without agent runs reports none", async () => {
  // deno-lint-ignore no-explicit-any
  const { json, markdown } = await report.execute(context([]) as any);
  assertEquals(json.runs, []);
  assertStringIncludes(markdown, "0 agent runs");
});

Deno.test("formatDuration", () => {
  assertEquals(formatDuration(4_500), "4.5s");
  assertEquals(formatDuration(123_000), "2m 3s");
  assertEquals(formatDuration(3_723_000), "1h 2m 3s");
});
