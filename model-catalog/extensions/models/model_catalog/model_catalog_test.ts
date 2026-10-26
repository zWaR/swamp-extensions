// SPDX-License-Identifier: Apache-2.0

import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.19";
import { createModelTestContext } from "@swamp-club/swamp-testing";
import { model } from "./model_catalog.ts";
import { CATALOG } from "./_lib/fixture_test.ts";

type Ctx = Parameters<typeof model.methods.resolveDispatch.execute>[1];
type Written = {
  specName: string;
  name: string;
  data: Record<string, unknown>;
};

const globalArgs = model.globalArguments.parse({
  catalog: CATALOG,
  roleMap: { build: "implementer" },
});

function context(
  opts: {
    stored?: Record<string, Record<string, unknown>>;
    invocations?: Record<string, { attributes: unknown }[]>;
  } = {},
) {
  const result = createModelTestContext({
    globalArgs,
    storedResources: opts.stored ?? {},
  });
  const reads: string[] = [];
  const ctx = {
    ...result.context,
    readModelData: (name: string, spec?: string) => {
      reads.push(`${name}/${spec}`);
      return Promise.resolve(opts.invocations?.[name] ?? []);
    },
  } as unknown as Ctx;
  return {
    ctx,
    reads,
    written: () => result.getWrittenResources() as Written[],
  };
}

const failedInvocation = (failureClass: string, model: string) => ({
  attributes: {
    invocationId: "x",
    startedAt: "2026-10-26T11:00:00.000Z",
    success: false,
    failureClass,
    model,
    tags: { workItem: "WI-1", phase: "build" },
  },
});

Deno.test("globalArguments rejects a roleMap that points at no catalog role", () => {
  const result = model.globalArguments.safeParse({
    catalog: CATALOG,
    roleMap: { build: "builder" },
  });
  assertEquals(result.success, false);
  assertStringIncludes(JSON.stringify(result.error), "not a catalog role");
});

Deno.test("resolveDispatch stores tier 0 for a first attempt", async () => {
  const { ctx, written, reads } = context();
  await model.methods.resolveDispatch.execute({
    workItem: "WI-1",
    role: "build",
    instanceName: "kiro",
    attempt: 1,
    maxAttempts: 3,
  }, ctx);
  assertEquals(reads, []);
  const [d] = written();
  assertEquals(d.name, "dispatch--WI-1--build--1");
  assertEquals(d.data.model, "claude-haiku-4.5");
  assertEquals(d.data.disposition, "initial");
});

Deno.test("resolveDispatch reads the failed invocation and advances from its tier", async () => {
  const { ctx, written, reads } = context({
    invocations: {
      kiro: [failedInvocation("quota", "claude-sonnet-4.6")],
    },
  });
  await model.methods.resolveDispatch.execute({
    workItem: "WI-1",
    role: "build",
    instanceName: "build-step",
    agentModel: "kiro",
    phase: "build",
    attempt: 2,
    maxAttempts: 3,
  }, ctx);
  assertEquals(reads, ["kiro/invocation"]);
  const fallback = written().find((w) => w.specName === "fallback")!;
  const dispatch = written().find((w) => w.specName === "dispatch")!;
  assertEquals(fallback.name, "fallback--WI-1--build--2");
  assertEquals(fallback.data.disposition, "advance");
  assertEquals(dispatch.data.tier, 2);
  assertEquals(dispatch.data.model, "claude-opus-4.8");
  assertEquals(dispatch.data.signalSource, "invocation");
  assertEquals(dispatch.data.instanceName, "build-step");
});

Deno.test("resolveDispatch: an explicit signalClass wins over the invocation feed", async () => {
  const { ctx, written, reads } = context({
    invocations: { kiro: [failedInvocation("quota", "claude-haiku-4.5")] },
  });
  await model.methods.resolveDispatch.execute({
    workItem: "WI-1",
    role: "build",
    instanceName: "kiro",
    phase: "build",
    signalClass: "contract-violation",
    attempt: 2,
    maxAttempts: 3,
  }, ctx);
  assertEquals(reads, []);
  const dispatch = written().find((w) => w.specName === "dispatch")!;
  assertEquals(dispatch.data.disposition, "no-fallback");
  assertEquals(dispatch.data.signalSource, "argument");
});

Deno.test("resolveDispatch replays an identical stored result and rejects a different one", async () => {
  const first = context();
  const call = {
    workItem: "WI-1",
    role: "build",
    instanceName: "kiro",
    attempt: 2,
    signalClass: "rate-limit" as const,
    maxAttempts: 3,
  };
  await model.methods.resolveDispatch.execute(call, first.ctx);
  const stored = Object.fromEntries(
    first.written().map((w) => [w.name, w.data]),
  );

  const replay = context({ stored });
  const result = await model.methods.resolveDispatch.execute(call, replay.ctx);
  assertEquals(result.dataHandles, []);
  assertEquals(replay.written(), []);

  await assertRejects(
    () =>
      model.methods.resolveDispatch.execute(
        { ...call, signalClass: "quota" },
        context({ stored }).ctx,
      ),
    Error,
    "already stored with a different result",
  );
});

Deno.test("resolveDispatch keeps a stored result when the invocation feed has moved on", async () => {
  const first = context({
    invocations: { kiro: [failedInvocation("quota", "claude-haiku-4.5")] },
  });
  const call = {
    workItem: "WI-1",
    role: "build",
    instanceName: "kiro",
    phase: "build",
    attempt: 2,
    maxAttempts: 3,
  };
  await model.methods.resolveDispatch.execute(call, first.ctx);
  const stored = Object.fromEntries(
    first.written().map((w) => [w.name, w.data]),
  );
  // The retry on tier 1 succeeded, so the feed now reports no failure.
  const later = context({ stored, invocations: { kiro: [] } });
  const result = await model.methods.resolveDispatch.execute(call, later.ctx);
  assertEquals(result.dataHandles, []);
  assertEquals(later.reads, []);
  assertEquals(later.written(), []);
});

Deno.test("resolveDispatch writes nothing when the fallback decision conflicts", async () => {
  const first = context();
  await model.methods.recordFallback.execute({
    workItem: "WI-1",
    role: "build",
    currentTier: 0,
    signalClass: "quota",
    attempt: 2,
    maxAttempts: 2,
  }, first.ctx);
  const stored = Object.fromEntries(
    first.written().map((w) => [w.name, w.data]),
  );
  const later = context({ stored });
  await assertRejects(
    () =>
      model.methods.resolveDispatch.execute({
        workItem: "WI-1",
        role: "build",
        instanceName: "kiro",
        signalClass: "quota",
        attempt: 2,
        maxAttempts: 3,
      }, later.ctx),
    Error,
    "fallback--WI-1--build--2 is already stored",
  );
  assertEquals(later.written(), []);
});

Deno.test("resolveDispatch fails closed on an unknown role and writes nothing", async () => {
  const { ctx, written } = context();
  await assertRejects(
    () =>
      model.methods.resolveDispatch.execute({
        workItem: "WI-1",
        role: "tester",
        instanceName: "kiro",
        attempt: 1,
        maxAttempts: 3,
      }, ctx),
    Error,
    "not in the catalog",
  );
  assertEquals(written(), []);
});

Deno.test("recordFallback stores the decision", async () => {
  const { ctx, written } = context();
  await model.methods.recordFallback.execute({
    workItem: "WI-1",
    role: "reviewer",
    currentTier: 0,
    signalClass: "rate-limit",
    attempt: 1,
    maxAttempts: 3,
  }, ctx);
  const [f] = written();
  assertEquals(f.name, "fallback--WI-1--reviewer--1");
  assertEquals(f.data.disposition, "park");
});
