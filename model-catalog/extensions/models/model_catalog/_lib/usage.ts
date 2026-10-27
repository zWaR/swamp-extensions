/**
 * Pure usage aggregation: sums `@cachehit/agents/kiro` invocation records into
 * credit, outcome, retry and duration buckets per job and catalog role.
 * Nothing here reads or writes swamp data.
 *
 * @module
 */
// SPDX-License-Identifier: Apache-2.0

import { z } from "npm:zod@4.6.5";
import { catalogRoleFor } from "./catalog.ts";

/** Invocation record attributes read from `@cachehit/agents/kiro` data. */
export const InvocationUsageSchema = z.object({
  invocationId: z.string(),
  startedAt: z.string(),
  success: z.boolean(),
  credits: z.number().nullable(),
  durationMs: z.number(),
  model: z.string(),
  tags: z.record(z.string(), z.string()).default({}),
  attempts: z.array(z.unknown()).optional(),
});
type InvocationUsage = z.infer<typeof InvocationUsageSchema>;

/** Summed usage of a set of invocations. */
export const BucketSchema = z.object({
  invocations: z.number(),
  succeeded: z.number(),
  failed: z.number(),
  credits: z.number(),
  creditsMissing: z.number(),
  retries: z.number(),
  durationMs: z.number(),
  models: z.record(z.string(), z.number()),
});
export type Bucket = z.infer<typeof BucketSchema>;

/** A usage report: totals, per role, per job and the unattributed rest. */
export const UsageSchema = z.object({
  reportName: z.string(),
  agentModel: z.string(),
  workItem: z.string().nullable(),
  generatedAt: z.string(),
  unit: z.literal("credits"),
  tokensAvailable: z.literal(false),
  totals: BucketSchema,
  byRole: z.record(z.string(), BucketSchema),
  jobs: z.array(z.object({
    job: z.string(),
    total: BucketSchema,
    roles: z.record(z.string(), BucketSchema),
  })),
  unattributed: BucketSchema,
});
export type Usage = z.infer<typeof UsageSchema>;

/** Name of the stored usage report. */
export const usageName = (reportName: string): string => `usage--${reportName}`;

/** The string-valued entries of a record's swamp tags. */
function stringTags(tags: unknown): Record<string, string> {
  if (!tags || typeof tags !== "object") return {};
  return Object.fromEntries(
    Object.entries(tags).filter(([, v]) => typeof v === "string"),
  );
}

const emptyBucket = (): Bucket => ({
  invocations: 0,
  succeeded: 0,
  failed: 0,
  credits: 0,
  creditsMissing: 0,
  retries: 0,
  durationMs: 0,
  models: {},
});

function add(b: Bucket, i: InvocationUsage): void {
  b.invocations += 1;
  if (i.success) b.succeeded += 1;
  else b.failed += 1;
  if (i.credits === null) b.creditsMissing += 1;
  else b.credits += i.credits;
  b.retries += i.attempts ? Math.max(i.attempts.length - 1, 0) : 0;
  b.durationMs += i.durationMs;
  b.models[i.model] =
    (Object.hasOwn(b.models, i.model) ? b.models[i.model] : 0) +
    1;
}

const round = (b: Bucket): Bucket => ({
  ...b,
  credits: Math.round(b.credits * 1e6) / 1e6,
});

// Maps keep role and job names like "__proto__" from touching prototypes.
function bucketIn<K>(map: Map<K, Bucket>, key: K): Bucket {
  let b = map.get(key);
  if (!b) map.set(key, b = emptyBucket());
  return b;
}

const roundAll = (map: Map<string, Bucket>) =>
  Object.fromEntries([...map].map(([k, b]) => [k, round(b)]));

/**
 * Aggregates invocation records into a usage report. Records that do not
 * parse are skipped; with a work item or filter tags, only invocations tagged
 * with them count. Tags are the swamp record tags merged with the invocation
 * tags.
 */
export function aggregateUsage(
  records: { attributes?: unknown; tags?: unknown }[],
  opts: {
    agentModel: string;
    reportName: string;
    workItem: string | null;
    workItemTagKey: string;
    /** Every one of these tags must match. */
    filterTags: Record<string, string>;
    jobTagKey: string;
    roleTagKey: string;
    roleMap: Record<string, string>;
    generatedAt: string;
  },
): Usage {
  const totals = emptyBucket();
  const unattributed = emptyBucket();
  const byRole = new Map<string, Bucket>();
  const jobs = new Map<
    string,
    { firstStartedAt: string; total: Bucket; roles: Map<string, Bucket> }
  >();

  for (const record of records) {
    const parsed = InvocationUsageSchema.safeParse(record.attributes);
    if (!parsed.success) continue;
    // Swamp tags data written by a workflow step with job, step and
    // workflowRunId; the invocation's own tags win on a clash.
    const i = {
      ...parsed.data,
      tags: { ...stringTags(record.tags), ...parsed.data.tags },
    };
    if (
      opts.workItem !== null && i.tags[opts.workItemTagKey] !== opts.workItem
    ) continue;
    if (
      Object.entries(opts.filterTags).some(([k, v]) =>
        !Object.hasOwn(i.tags, k) || i.tags[k] !== v
      )
    ) continue;
    add(totals, i);
    const job = i.tags[opts.jobTagKey];
    const rawRole = i.tags[opts.roleTagKey];
    if (!job || !rawRole) {
      add(unattributed, i);
      continue;
    }
    const role = catalogRoleFor(opts.roleMap, rawRole);
    add(bucketIn(byRole, role), i);
    let entry = jobs.get(job);
    if (!entry) {
      entry = {
        firstStartedAt: i.startedAt,
        total: emptyBucket(),
        roles: new Map(),
      };
      jobs.set(job, entry);
    } else if (i.startedAt < entry.firstStartedAt) {
      entry.firstStartedAt = i.startedAt;
    }
    add(entry.total, i);
    add(bucketIn(entry.roles, role), i);
  }

  return {
    reportName: opts.reportName,
    agentModel: opts.agentModel,
    workItem: opts.workItem,
    generatedAt: opts.generatedAt,
    unit: "credits",
    tokensAvailable: false,
    totals: round(totals),
    byRole: roundAll(byRole),
    jobs: [...jobs]
      .sort(([a, x], [b, y]) =>
        x.firstStartedAt < y.firstStartedAt
          ? -1
          : x.firstStartedAt > y.firstStartedAt
          ? 1
          : a < b
          ? -1
          : a > b
          ? 1
          : 0
      )
      .map(([job, e]) => ({
        job,
        total: round(e.total),
        roles: roundAll(e.roles),
      })),
    unattributed: round(unattributed),
  };
}
