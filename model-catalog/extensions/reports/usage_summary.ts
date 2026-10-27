/**
 * Workflow-scope report: at the end of a workflow run, sums the
 * `@cachehit/agents` invocations (Kiro or Claude Code) its steps wrote, per
 * role and per run, with credits, cost, tokens, agent time and wall time.
 *
 * @module
 */
// SPDX-License-Identifier: Apache-2.0

import { z } from "npm:zod@4.6.5";
import { catalogRoleFor } from "../models/model_catalog/_lib/catalog.ts";
import {
  aggregateUsage,
  type Bucket,
  InvocationUsageSchema,
} from "../models/model_catalog/_lib/usage.ts";

/** Type prefix of the `@cachehit/agents` model types. */
const AGENT_TYPE_PREFIX = "@cachehit/agents/";
/** Model type whose `roleMap` folds role tags. */
const CATALOG_TYPE = "@cachehit/model-catalog";

/** Invocation attributes the report reads. */
const RunSchema = InvocationUsageSchema.extend({
  // Older invocations always have it; fall back to startedAt + durationMs.
  finishedAt: z.string().optional(),
});

/** The fields of a data handle the report reads. */
type Handle = { name: string; specName: string; version?: number };
/** A workflow step execution, as the report context gives it. */
type Step = {
  jobName: string;
  stepName: string;
  modelName: string;
  modelType: string;
  modelId: string;
  dataHandles: Handle[];
  globalArgs: Record<string, unknown>;
};
/** The workflow report context fields the report reads. */
type Context = {
  workflowName: string;
  workflowRunId: string;
  workflowStatus: string;
  stepExecutions: Step[];
  dataRepository: {
    getContent: (
      type: string,
      modelId: string,
      dataName: string,
      version?: number,
    ) => Promise<Uint8Array | null>;
  };
};

/** One agent run: an invocation record with its step and role. */
type Run = {
  role: string;
  job: string;
  step: string;
  agent: string;
  model: string;
  success: boolean;
  credits: number | null;
  costUsd: number | null;
  tokens: z.infer<typeof RunSchema>["tokens"];
  retries: number;
  durationMs: number;
  startedAt: string;
  finishedAt: string;
};

/** Formats milliseconds as `1h 2m 3s`, `2m 3s` or `4.5s`. */
export function formatDuration(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m ${s % 60}s` : `${m}m ${s % 60}s`;
}

/** Shown for a value the agent did not report. */
const DASH = "—";
/** Kiro credits, rounded to 6 decimals. */
const credits = (n: number | null) =>
  n === null ? DASH : String(Math.round(n * 1e6) / 1e6);
/** Claude Code dollar cost. */
const usd = (n: number | null) => n === null ? DASH : `$${n.toFixed(4)}`;
/** Input / output / cache (read plus creation) tokens. */
const tokens = (t: Run["tokens"]) =>
  t === null
    ? DASH
    : `${t.input} / ${t.output} / ${t.cacheRead + t.cacheCreation}`;

/** Milliseconds from the earliest start to the latest finish of the runs. */
function wallMs(runs: Run[]): number {
  if (runs.length === 0) return 0;
  const start = Math.min(...runs.map((r) => Date.parse(r.startedAt)));
  const end = Math.max(...runs.map((r) => Date.parse(r.finishedAt)));
  return end - start;
}

/** Reads the invocation records the workflow's agent steps wrote. */
async function readRuns(context: Context): Promise<Run[]> {
  const catalogStep = context.stepExecutions.find((s) =>
    s.modelType === CATALOG_TYPE
  );
  const roleMap = z.record(z.string(), z.string()).catch({}).parse(
    catalogStep?.globalArgs.roleMap ?? {},
  );
  const runs: Run[] = [];
  for (const step of context.stepExecutions) {
    if (!step.modelType.startsWith(AGENT_TYPE_PREFIX)) continue;
    for (const h of step.dataHandles) {
      if (h.specName !== "invocation") continue;
      const raw = await context.dataRepository.getContent(
        step.modelType,
        step.modelId,
        h.name,
        h.version,
      );
      if (!raw) continue;
      const parsed = RunSchema.safeParse(
        JSON.parse(new TextDecoder().decode(raw)),
      );
      if (!parsed.success) continue;
      const i = parsed.data;
      runs.push({
        // Untagged runs are named after their step, so none go missing.
        role: catalogRoleFor(roleMap, i.tags.role ?? step.stepName),
        job: step.jobName,
        step: step.stepName,
        agent: step.modelType.slice(AGENT_TYPE_PREFIX.length),
        model: i.model,
        success: i.success,
        credits: i.credits,
        costUsd: i.costUsd,
        tokens: i.tokens,
        retries: i.attempts ? Math.max(i.attempts.length - 1, 0) : 0,
        durationMs: i.durationMs,
        startedAt: i.startedAt,
        finishedAt: i.finishedAt ??
          new Date(Date.parse(i.startedAt) + i.durationMs).toISOString(),
      });
    }
  }
  return runs.sort((a, b) =>
    a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0
  );
}

/** Builds the markdown and JSON summary from the runs. */
export function summarize(context: Context, runs: Run[]) {
  const usage = aggregateUsage(
    runs.map((r) => ({
      attributes: {
        invocationId: `${r.step}-${r.startedAt}`,
        startedAt: r.startedAt,
        success: r.success,
        credits: r.credits,
        costUsd: r.costUsd,
        tokens: r.tokens,
        durationMs: r.durationMs,
        model: r.model,
        tags: { job: r.job, role: r.role },
        attempts: Array(r.retries + 1).fill(null),
      },
    })),
    {
      agentModels: [],
      reportName: context.workflowRunId,
      workItem: null,
      workItemTagKey: "workItem",
      filterTags: {},
      jobTagKey: "job",
      roleTagKey: "role",
      roleMap: {},
      generatedAt: new Date().toISOString(),
    },
  );
  const roles = Object.entries(usage.byRole).map(([role, bucket]) => ({
    role,
    ...bucket,
    wallMs: wallMs(runs.filter((r) => r.role === role)),
  }));
  const totalWallMs = wallMs(runs);

  const roleRow = (name: string, b: Bucket, wall: number) =>
    `| ${name} | ${b.invocations} | ${b.failed} | ${
      b.creditsMissing === b.invocations ? DASH : b.credits
    } | ${usd(b.costUsd)} | ${tokens(b.tokens)} | ${
      formatDuration(b.durationMs)
    } | ${formatDuration(wall)} | ${b.retries} |`;

  const md = [
    "# Agent usage",
    "",
    `Workflow \`${context.workflowName}\` ${context.workflowStatus}: ${runs.length} agent runs, ${
      formatDuration(totalWallMs)
    } from the first start to the last finish.`,
  ];
  if (runs.length > 0) {
    md.push(
      "",
      "## By role",
      "",
      "| Role | Runs | Failed | Credits | Cost | Tokens in / out / cache | Agent time | Wall time | Retries |",
      "| ---- | ---: | -----: | ------: | ---: | ----------------------- | ---------: | --------: | ------: |",
      ...roles.map((r) => roleRow(r.role, r, r.wallMs)),
      roleRow("**Total**", usage.totals, totalWallMs),
      "",
      "## Runs",
      "",
      "| Role | Step | Agent | Model | Status | Credits | Cost | Tokens in / out / cache | Duration | Retries |",
      "| ---- | ---- | ----- | ----- | ------ | ------: | ---: | ----------------------- | -------: | ------: |",
      ...runs.map((r) =>
        `| ${r.role} | ${r.job}/${r.step} | ${r.agent} | ${r.model} | ${
          r.success ? "ok" : "failed"
        } | ${credits(r.credits)} | ${usd(r.costUsd)} | ${tokens(r.tokens)} | ${
          formatDuration(r.durationMs)
        } | ${r.retries} |`
      ),
      "",
      "Agent time sums each run's duration; wall time spans the first start to the last finish, so parallel runs overlap. Kiro reports credits and Claude Code reports cost and tokens.",
    );
  }
  return {
    markdown: md.join("\n") + "\n",
    json: {
      workflowName: context.workflowName,
      workflowRunId: context.workflowRunId,
      workflowStatus: context.workflowStatus,
      wallMs: totalWallMs,
      totals: usage.totals,
      byRole: Object.fromEntries(roles.map(({ role, ...b }) => [role, b])),
      runs,
    },
  };
}

/** Workflow report: agent usage per role and per run, shown when the run ends. */
export const report = {
  name: "@cachehit/model-catalog/usage-summary",
  description:
    "Credits, cost, tokens and run time of each @cachehit/agents run in a workflow, per role and per run",
  scope: "workflow" as const,
  labels: ["ai", "agent", "usage", "cost"],
  execute: async (context: Context) =>
    summarize(context, await readRuns(context)),
};
