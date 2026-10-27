/**
 * A caller-owned catalog that maps kinds of work (roles) to ordered model
 * tiers, for agent steps run with `@cachehit/agents`. `resolveDispatch` tells
 * a workflow step which model, tool profile and effort to use; a rate limit,
 * quota or unavailable model moves the role to its next tier. `usageReport`
 * stores credits, cost, tokens, runs and failures per job and role from agent
 * invocations.
 *
 * @module
 */
// SPDX-License-Identifier: Apache-2.0

import { z } from "npm:zod@4.6.5";
import {
  type Catalog,
  catalogRoleFor,
  CatalogSchema,
  decideFallback,
  type Decision,
  DecisionSchema,
  dispatchName,
  fallbackName,
  latestFailure,
  NameSchema,
  ResolutionSchema,
  resolveDispatch,
  SignalClassSchema,
  stableJson,
  tierOfModel,
} from "./_lib/catalog.ts";
import { aggregateUsage, usageName, UsageSchema } from "./_lib/usage.ts";

const GlobalArgsSchema = z.object({
  catalog: CatalogSchema.describe(
    "Your table: version plus roles, each with ordered tiers {model, costClass, toolProfile?, effort?}",
  ),
  roleMap: z.record(NameSchema, NameSchema).default({}).describe(
    'Folds your own role names onto catalog roles, for example {"security-review":"reviewer"}',
  ),
  signalTagKeys: z.object({
    workItem: z.string().min(1),
    phase: z.string().min(1),
  }).default({ workItem: "workItem", phase: "phase" }).describe(
    "Invocation tag keys that identify the work item and phase of an agent run",
  ),
}).superRefine((g, ctx) => {
  for (const [from, to] of Object.entries(g.roleMap)) {
    if (!Object.hasOwn(g.catalog.roles, to)) {
      ctx.addIssue({
        code: "custom",
        path: ["roleMap", from],
        message: `maps to "${to}", which is not a catalog role`,
      });
    }
  }
});
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const MaxAttemptsSchema = z.number().int().min(1).max(20).default(3).describe(
  "Park instead of advancing once attempt reaches this",
);

const RecordFallbackArgsSchema = z.object({
  workItem: NameSchema,
  role: NameSchema,
  currentTier: z.number().int().nonnegative().default(0),
  signalClass: SignalClassSchema,
  attempt: z.number().int().positive().default(1),
  maxAttempts: MaxAttemptsSchema,
});
type RecordFallbackArgs = z.infer<typeof RecordFallbackArgsSchema>;

const ResolveDispatchArgsSchema = z.object({
  workItem: NameSchema.describe("Identifies the task the step works on"),
  role: NameSchema.describe("Kind of work; a catalog role or a roleMap key"),
  instanceName: z.string().trim().min(1).describe(
    "Agent step or model instance; recorded unchanged",
  ),
  attempt: z.number().int().positive().default(1),
  currentTier: z.number().int().nonnegative().optional().describe(
    "Tier the previous attempt ran on; inferred from the failed invocation's model when read from agentModel, else 0",
  ),
  signalClass: SignalClassSchema.optional().describe(
    "Failure class of the previous attempt; wins over the invocation read via phase",
  ),
  phase: NameSchema.optional().describe(
    "Read the newest invocation tagged with workItem and this phase from agentModel",
  ),
  agentModel: z.string().min(1).optional().describe(
    "@cachehit/agents model instance to read invocations from; defaults to instanceName",
  ),
  maxAttempts: MaxAttemptsSchema,
});
type ResolveDispatchArgs = z.infer<typeof ResolveDispatchArgsSchema>;

const UsageReportArgsSchema = z.object({
  agentModel: z.union([
    z.string().min(1),
    z.array(z.string().min(1)).min(1),
  ]).describe(
    "@cachehit/agents model instance, or a list of them, to read invocations from",
  ),
  reportName: NameSchema.default("latest").describe(
    "Name of the stored report; a new run with the same name replaces it",
  ),
  workItem: NameSchema.optional().describe(
    "Keep only invocations tagged with this work item (tag key from signalTagKeys.workItem)",
  ),
  filterTags: z.record(z.string(), z.string()).default({}).describe(
    'Keep only invocations with all of these tags, for example {"workflowRunId":"<run ID>"}',
  ),
  jobTagKey: z.string().min(1).default("job").describe(
    "Tag key that holds the workflow job; swamp sets job on data written by a workflow step",
  ),
  roleTagKey: z.string().min(1).default("role").describe(
    "Invocation tag key that holds the role; folded through roleMap",
  ),
});
type UsageReportArgs = z.infer<typeof UsageReportArgsSchema>;

const NO_READ_MODEL_DATA = "this swamp version cannot read other models' data";

type Handle = Record<string, unknown>;
type Logger = (message: string, fields?: Record<string, unknown>) => void;
type Ctx = {
  globalArgs: GlobalArgs;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
    overrides?: { tags?: Record<string, string> },
  ) => Promise<Handle>;
  readResource: (name: string) => Promise<Record<string, unknown> | null>;
  readModelData?: (
    modelName: string,
    specName?: string,
  ) => Promise<{ attributes?: unknown; tags?: unknown }[]>;
  logger: { info: Logger };
};

/** A record to store once under its name, and how to recompute a stored copy. */
interface Pending {
  spec: string;
  name: string;
  data: Record<string, unknown>;
  recompute: (stored: Record<string, unknown>) => unknown;
  tags: Record<string, string>;
}

/**
 * Stores each record unless the same one is already stored. Every name is
 * checked before anything is written, so a conflict leaves no partial write.
 * A stored record that differs (other than its timestamp, which `recompute`
 * takes) is a conflict: the key was already decided differently.
 */
async function writeOnce(ctx: Ctx, records: Pending[]): Promise<Handle[]> {
  const missing: Pending[] = [];
  for (const r of records) {
    const stored = await ctx.readResource(r.name);
    if (!stored) missing.push(r);
    else if (stableJson(stored) !== stableJson(r.recompute(stored))) {
      throw new Error(
        `${r.name} is already stored with a different result; use a new attempt number`,
      );
    }
  }
  const handles: Handle[] = [];
  for (const r of missing) {
    handles.push(
      await ctx.writeResource(r.spec, r.name, r.data, { tags: r.tags }),
    );
  }
  return handles;
}

const decisionTags = (workItem: string, d: Decision) => ({
  workItem,
  role: d.role,
  signalClass: d.signalClass,
  disposition: d.disposition,
  attempt: String(d.attempt),
});

/** Model catalog with tiered fallback for agent steps. */
export const model = {
  type: "@cachehit/model-catalog",
  version: "2026.10.27.2",
  upgrades: [{
    toVersion: "2026.10.27.1",
    description: "Adds the usageReport method and usage resource",
    upgradeAttributes: (old: Record<string, unknown>) => old,
  }, {
    toVersion: "2026.10.27.2",
    description:
      "Adds the claude provider; usage reports add costUsd and tokens and read several agent models",
    upgradeAttributes: (old: Record<string, unknown>) => old,
  }],
  globalArguments: GlobalArgsSchema,
  resources: {
    dispatch: {
      description:
        "Model, tier, tool profile and effort a step uses for one (workItem, role, attempt)",
      schema: ResolutionSchema,
      lifetime: "infinite" as const,
      garbageCollection: 40,
    },
    fallback: {
      description:
        "Fallback decision (advance, no-fallback or park) for one (workItem, role, attempt)",
      schema: DecisionSchema,
      lifetime: "infinite" as const,
      garbageCollection: 40,
    },
    usage: {
      description:
        "Credits, cost, tokens, runs, failures, retries and duration per job and role, read from @cachehit/agents invocations",
      schema: UsageSchema,
      lifetime: "30d" as const,
      garbageCollection: 40,
    },
  },
  methods: {
    resolveDispatch: {
      description:
        "Store the model, tool profile and effort a step should use for this attempt, moving to the next tier after a rate limit, quota or unavailable model",
      arguments: ResolveDispatchArgsSchema,
      execute: async (args: ResolveDispatchArgs, ctx: Ctx) => {
        const g = ctx.globalArgs;
        const catalogRole = catalogRoleFor(g.roleMap, args.role);
        ctx.logger.info("Resolving {role} for {workItem}, attempt {attempt}", {
          role: args.role,
          workItem: args.workItem,
          attempt: args.attempt,
        });
        let signalClass: string | null = args.signalClass ?? null;
        let signalSource: "argument" | "invocation" | null = signalClass
          ? "argument"
          : null;
        let fedTier: number | null = null;
        if (!signalClass && args.phase) {
          // Later runs change what the invocation feed returns, so a stored
          // resolution for this key is final instead of being re-checked.
          const stored = await ctx.readResource(
            dispatchName(args.workItem, args.role, args.attempt),
          );
          if (stored) {
            ctx.logger.info("{role} attempt {attempt} already resolved", {
              role: args.role,
              attempt: args.attempt,
            });
            return { dataHandles: [] };
          }
          if (!ctx.readModelData) {
            throw new Error(
              `${NO_READ_MODEL_DATA}; pass signalClass instead of phase`,
            );
          }
          const source = args.agentModel ?? args.instanceName;
          const failure = latestFailure(
            await ctx.readModelData(source, "invocation"),
            args.workItem,
            args.phase,
            g.signalTagKeys,
          );
          if (failure) {
            signalClass = failure.signalClass;
            signalSource = "invocation";
            fedTier = tierOfModel(g.catalog, catalogRole, failure.model);
          }
        }
        const run = (resolvedAt: string) =>
          resolveDispatch(g.catalog as Catalog, g.roleMap, {
            workItem: args.workItem,
            role: args.role,
            instanceName: args.instanceName,
            attempt: args.attempt,
            currentTier: args.currentTier ?? fedTier ?? 0,
            signalClass,
            signalSource,
            maxAttempts: args.maxAttempts,
          }, resolvedAt);
        const { resolution, decision } = run(new Date().toISOString());

        const records: Pending[] = [];
        if (decision) {
          records.push({
            spec: "fallback",
            name: resolution.fallbackRef!,
            data: decision,
            recompute: (stored) => run(String(stored.decidedAt)).decision,
            tags: decisionTags(args.workItem, decision),
          });
        }
        records.push({
          spec: "dispatch",
          name: dispatchName(args.workItem, args.role, args.attempt),
          data: resolution,
          recompute: (stored) => run(String(stored.resolvedAt)).resolution,
          tags: {
            workItem: args.workItem,
            role: args.role,
            disposition: resolution.disposition,
            attempt: String(args.attempt),
          },
        });
        const handles = await writeOnce(ctx, records);
        ctx.logger.info(
          "{role} attempt {attempt}: {disposition}, tier {tier} {model}",
          {
            role: args.role,
            attempt: args.attempt,
            disposition: resolution.disposition,
            tier: resolution.tier,
            model: resolution.model,
          },
        );
        return { dataHandles: handles };
      },
    },
    recordFallback: {
      description:
        "Store the fallback decision for a failure signal without resolving a dispatch",
      arguments: RecordFallbackArgsSchema,
      execute: async (args: RecordFallbackArgs, ctx: Ctx) => {
        const g = ctx.globalArgs;
        const catalogRole = catalogRoleFor(g.roleMap, args.role);
        ctx.logger.info("Deciding fallback for {role} after {signal}", {
          role: args.role,
          signal: args.signalClass,
        });
        const decide = (decidedAt: string) =>
          decideFallback(
            g.catalog as Catalog,
            catalogRole,
            args.currentTier,
            args.signalClass,
            args.attempt,
            args.maxAttempts,
            decidedAt,
          );
        const decision = decide(new Date().toISOString());
        const handles = await writeOnce(ctx, [{
          spec: "fallback",
          name: fallbackName(args.workItem, args.role, args.attempt),
          data: decision,
          recompute: (stored) => decide(String(stored.decidedAt)),
          tags: decisionTags(args.workItem, decision),
        }]);
        ctx.logger.info("{role}: {disposition}", {
          role: args.role,
          disposition: decision.disposition,
        });
        return { dataHandles: handles };
      },
    },
    usageReport: {
      description:
        "Store a usage report (Kiro credits, Claude Code cost and tokens) per job and role from the invocations of @cachehit/agents models",
      arguments: UsageReportArgsSchema,
      execute: async (args: UsageReportArgs, ctx: Ctx) => {
        const g = ctx.globalArgs;
        const agentModels = [args.agentModel].flat();
        ctx.logger.info("Building usage report {report} from {agentModels}", {
          report: args.reportName,
          agentModels: agentModels.join(", "),
        });
        if (!ctx.readModelData) throw new Error(NO_READ_MODEL_DATA);
        const records = [];
        for (const name of agentModels) {
          records.push(...await ctx.readModelData(name, "invocation"));
        }
        const usage = aggregateUsage(
          records,
          {
            agentModels,
            reportName: args.reportName,
            workItem: args.workItem ?? null,
            workItemTagKey: g.signalTagKeys.workItem,
            filterTags: args.filterTags,
            jobTagKey: args.jobTagKey,
            roleTagKey: args.roleTagKey,
            roleMap: g.roleMap,
            generatedAt: new Date().toISOString(),
          },
        );
        // A report is a snapshot, so a rerun replaces it.
        const handle = await ctx.writeResource(
          "usage",
          usageName(args.reportName),
          usage,
        );
        ctx.logger.info(
          "{report}: {invocations} invocations, {credits} credits, ${cost}, {jobs} jobs",
          {
            report: args.reportName,
            invocations: usage.totals.invocations,
            credits: usage.totals.credits,
            cost: usage.totals.costUsd ?? 0,
            jobs: usage.jobs.length,
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
