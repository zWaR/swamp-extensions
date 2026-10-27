// SPDX-License-Identifier: Apache-2.0

import { assertEquals } from "jsr:@std/assert@1.0.19";
import {
  aggregateUsage,
  type Bucket,
  usageName,
  UsageSchema,
} from "./usage.ts";

const NOW = "2026-10-26T12:00:00.000Z";

const OPTS = {
  agentModel: "kiro",
  reportName: "weekly",
  workItem: null,
  workItemTagKey: "workItem",
  filterTags: {},
  jobTagKey: "job",
  roleTagKey: "role",
  roleMap: {},
  generatedAt: NOW,
};

let seq = 0;
/** A record with defaults; `tags` replaces the default job/role tags. */
function rec(over: Record<string, unknown> = {}): { attributes: unknown } {
  seq += 1;
  return {
    attributes: {
      invocationId: `inv-${seq}`,
      startedAt: "2026-10-26T10:00:00.000Z",
      success: true,
      credits: 1,
      durationMs: 100,
      model: "claude-haiku-4.5",
      tags: { job: "j1", role: "implementer" },
      ...over,
    },
  };
}

const bucket = (over: Partial<Bucket> = {}): Bucket => ({
  invocations: 0,
  succeeded: 0,
  failed: 0,
  credits: 0,
  creditsMissing: 0,
  retries: 0,
  durationMs: 0,
  models: {},
  ...over,
});

Deno.test("usageName prefixes the report name", () => {
  assertEquals(usageName("weekly"), "usage--weekly");
});

Deno.test("aggregateUsage sums per job and role, and byRole across jobs", () => {
  const u = aggregateUsage([
    rec({ credits: 1, durationMs: 100 }),
    rec({ credits: 2, durationMs: 200, model: "claude-sonnet-4.5" }),
    rec({ credits: 4, tags: { job: "j1", role: "reviewer" } }),
    rec({ credits: 8, tags: { job: "j2", role: "implementer" } }),
  ], OPTS);
  assertEquals(
    u.totals,
    bucket({
      invocations: 4,
      succeeded: 4,
      credits: 15,
      durationMs: 500,
      models: { "claude-haiku-4.5": 3, "claude-sonnet-4.5": 1 },
    }),
  );
  assertEquals(u.byRole, {
    implementer: bucket({
      invocations: 3,
      succeeded: 3,
      credits: 11,
      durationMs: 400,
      models: { "claude-haiku-4.5": 2, "claude-sonnet-4.5": 1 },
    }),
    reviewer: bucket({
      invocations: 1,
      succeeded: 1,
      credits: 4,
      durationMs: 100,
      models: { "claude-haiku-4.5": 1 },
    }),
  });
  assertEquals(u.jobs.map((j) => j.job), ["j1", "j2"]);
  assertEquals(
    u.jobs[0].total,
    bucket({
      invocations: 3,
      succeeded: 3,
      credits: 7,
      durationMs: 400,
      models: { "claude-haiku-4.5": 2, "claude-sonnet-4.5": 1 },
    }),
  );
  assertEquals(u.jobs[0].roles, {
    implementer: bucket({
      invocations: 2,
      succeeded: 2,
      credits: 3,
      durationMs: 300,
      models: { "claude-haiku-4.5": 1, "claude-sonnet-4.5": 1 },
    }),
    reviewer: bucket({
      invocations: 1,
      succeeded: 1,
      credits: 4,
      durationMs: 100,
      models: { "claude-haiku-4.5": 1 },
    }),
  });
  assertEquals(u.jobs[1], {
    job: "j2",
    total: bucket({
      invocations: 1,
      succeeded: 1,
      credits: 8,
      durationMs: 100,
      models: { "claude-haiku-4.5": 1 },
    }),
    roles: {
      implementer: bucket({
        invocations: 1,
        succeeded: 1,
        credits: 8,
        durationMs: 100,
        models: { "claude-haiku-4.5": 1 },
      }),
    },
  });
  assertEquals(u.unattributed, bucket());
});

Deno.test("aggregateUsage orders jobs by earliest startedAt, then name", () => {
  const u = aggregateUsage([
    rec({
      startedAt: "2026-10-26T12:00:00.000Z",
      tags: { job: "late", role: "r" },
    }),
    rec({
      startedAt: "2026-10-26T11:00:00.000Z",
      tags: { job: "b", role: "r" },
    }),
    rec({
      startedAt: "2026-10-26T11:00:00.000Z",
      tags: { job: "a", role: "r" },
    }),
    rec({
      startedAt: "2026-10-26T09:00:00.000Z",
      tags: { job: "late2", role: "r" },
    }),
    rec({
      startedAt: "2026-10-26T13:00:00.000Z",
      tags: { job: "late2", role: "r" },
    }),
    rec({
      startedAt: "2026-10-26T08:00:00.000Z",
      tags: { job: "late", role: "r" },
    }),
  ], OPTS);
  assertEquals(u.jobs.map((j) => j.job), ["late", "late2", "a", "b"]);
});

Deno.test("aggregateUsage puts invocations without job or role in unattributed", () => {
  const u = aggregateUsage([
    rec({ tags: { role: "implementer" }, credits: 2 }),
    rec({ tags: { job: "j1" }, credits: 3 }),
    rec({ tags: { job: "", role: "implementer" }, credits: 4 }),
    rec({ credits: 1 }),
  ], OPTS);
  assertEquals(u.totals.invocations, 4);
  assertEquals(u.totals.credits, 10);
  assertEquals(
    u.unattributed,
    bucket({
      invocations: 3,
      succeeded: 3,
      credits: 9,
      durationMs: 300,
      models: { "claude-haiku-4.5": 3 },
    }),
  );
  assertEquals(Object.keys(u.byRole), ["implementer"]);
  assertEquals(u.byRole.implementer.invocations, 1);
  assertEquals(u.jobs.length, 1);
  assertEquals(u.jobs[0].total.invocations, 1);
});

Deno.test("aggregateUsage counts null credits, failures and retries", () => {
  const u = aggregateUsage([
    rec({ credits: null }),
    rec({ success: false, credits: 2.5 }),
    rec({ attempts: [{}, {}, {}] }),
    rec({ attempts: [] }),
  ], OPTS);
  assertEquals(
    u.totals,
    bucket({
      invocations: 4,
      succeeded: 3,
      failed: 1,
      credits: 4.5,
      creditsMissing: 1,
      retries: 2,
      durationMs: 400,
      models: { "claude-haiku-4.5": 4 },
    }),
  );
});

Deno.test("aggregateUsage folds roles through the roleMap", () => {
  const u = aggregateUsage([
    rec({ tags: { job: "j1", role: "build" }, credits: 1 }),
    rec({ tags: { job: "j1", role: "implementer" }, credits: 2 }),
    rec({ tags: { job: "j1", role: "triage" }, credits: 4 }),
  ], { ...OPTS, roleMap: { build: "implementer" } });
  assertEquals(Object.keys(u.byRole).sort(), ["implementer", "triage"]);
  assertEquals(u.byRole.implementer.invocations, 2);
  assertEquals(u.byRole.implementer.credits, 3);
  assertEquals(u.byRole.triage.credits, 4);
  assertEquals(Object.keys(u.jobs[0].roles).sort(), ["implementer", "triage"]);
  assertEquals(u.jobs[0].roles.implementer.credits, 3);
});

Deno.test("aggregateUsage filters by work item with a custom tag key", () => {
  const u = aggregateUsage([
    rec({ tags: { ticket: "W-1", job: "j1", role: "r" }, credits: 1 }),
    rec({ tags: { ticket: "W-2", job: "j1", role: "r" }, credits: 2 }),
    rec({ tags: { workItem: "W-1", job: "j1", role: "r" }, credits: 4 }),
  ], { ...OPTS, workItem: "W-1", workItemTagKey: "ticket" });
  assertEquals(u.workItem, "W-1");
  assertEquals(u.totals.invocations, 1);
  assertEquals(u.totals.credits, 1);
});

Deno.test("aggregateUsage keeps only invocations with every filter tag", () => {
  const u = aggregateUsage([
    rec({ tags: { run: "r1", job: "j1", role: "r" }, credits: 1 }),
    rec({ tags: { run: "r2", job: "j1", role: "r" }, credits: 2 }),
    rec({ tags: { job: "j1", role: "r" }, credits: 4 }),
  ], { ...OPTS, filterTags: { run: "r1" } });
  assertEquals(u.totals.invocations, 1);
  assertEquals(u.totals.credits, 1);
});

Deno.test("aggregateUsage uses swamp record tags, with invocation tags winning", () => {
  const withRecordTags = (
    tags: Record<string, unknown>,
    r: { attributes?: unknown },
  ) => ({ ...r, tags });
  const u = aggregateUsage([
    withRecordTags(
      { job: "work", step: "subtask-0", workflowRunId: "run-1", n: 1 },
      rec({ tags: { role: "worker" }, credits: 1 }),
    ),
    withRecordTags(
      { job: "plan", workflowRunId: "run-1" },
      rec({ tags: { job: "review", role: "orchestrator" }, credits: 2 }),
    ),
    withRecordTags(
      { job: "work", workflowRunId: "run-2" },
      rec({ tags: { role: "worker" }, credits: 4 }),
    ),
  ], { ...OPTS, filterTags: { workflowRunId: "run-1" } });
  assertEquals(u.totals.credits, 3);
  assertEquals(u.jobs.map((j) => j.job).sort(), ["review", "work"]);
  assertEquals(u.byRole.worker.credits, 1);
  assertEquals(u.unattributed.invocations, 0);
});

Deno.test("aggregateUsage ignores records that do not parse", () => {
  const u = aggregateUsage([
    {},
    { attributes: null },
    rec({ credits: "1" }),
    rec({ success: "yes" }),
    rec({ invocationId: undefined }),
    rec({ credits: 1 }),
  ], OPTS);
  assertEquals(u.totals.invocations, 1);
  assertEquals(u.totals.credits, 1);
});

Deno.test("aggregateUsage rounds credits and returns a valid report", () => {
  const u = aggregateUsage(
    [rec({ credits: 0.1 }), rec({ credits: 0.2 })],
    OPTS,
  );
  assertEquals(u.totals.credits, 0.3);
  assertEquals(u.byRole.implementer.credits, 0.3);
  assertEquals(u.jobs[0].total.credits, 0.3);
  assertEquals(u.jobs[0].roles.implementer.credits, 0.3);
  assertEquals(UsageSchema.parse(u), u);
  assertEquals(
    {
      reportName: u.reportName,
      agentModel: u.agentModel,
      workItem: u.workItem,
      generatedAt: u.generatedAt,
      unit: u.unit,
      tokensAvailable: u.tokensAvailable,
    },
    {
      reportName: "weekly",
      agentModel: "kiro",
      workItem: null,
      generatedAt: NOW,
      unit: "credits",
      tokensAvailable: false,
    },
  );
});

Deno.test("aggregateUsage with no records returns empty buckets", () => {
  const u = aggregateUsage([], OPTS);
  assertEquals(u.totals, bucket());
  assertEquals(u.unattributed, bucket());
  assertEquals(u.byRole, {});
  assertEquals(u.jobs, []);
  assertEquals(UsageSchema.parse(u), u);
});
