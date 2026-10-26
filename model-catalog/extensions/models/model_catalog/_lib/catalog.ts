/**
 * Pure catalog logic: a caller-owned table maps work roles to ordered model
 * tiers; a classified failure signal decides whether a role moves to its next
 * tier. Nothing here reads or writes swamp data.
 *
 * @module
 */
// SPDX-License-Identifier: Apache-2.0

import { z } from "npm:zod@4.6.5";

/** Agent CLIs a tier can name; each has a matching `@cachehit/agents` model type. */
export const ProviderSchema = z.enum(["kiro"]);

/** Role, work item and phase names; also used in data instance names. */
export const NameSchema = z.string().regex(
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/,
  "use 1-64 letters, digits, '.', '_' or '-', starting with a letter or digit",
);

/** One candidate in a role's ordered tier list. */
export const CandidateSchema = z.object({
  provider: ProviderSchema.default("kiro"),
  model: z.string().trim().min(1).describe(
    "Model ID, for example claude-haiku-4.5",
  ),
  costClass: z.enum(["low", "medium", "high"]).describe(
    "Advisory cost band; selection follows tier order",
  ),
  toolProfile: z.enum(["readonly", "actor"]).optional().describe(
    "Tool profile the agent step should use for this tier",
  ),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
  notes: z.string().trim().min(1).optional(),
}).strict();
export type Candidate = z.infer<typeof CandidateSchema>;

/** The versioned, role-indexed catalog. */
export const CatalogSchema = z.object({
  version: z.string().min(1).describe(
    "Opaque version you bump when the table changes",
  ),
  roles: z.record(
    NameSchema,
    z.object({
      tiers: z.array(CandidateSchema).min(1).refine(
        (tiers) =>
          new Set(tiers.map((t) => `${t.provider}/${t.model}`)).size ===
            tiers.length,
        "a role's tiers must not repeat a provider/model pair",
      ),
    }).strict(),
  ).refine(
    (roles) => Object.keys(roles).length > 0,
    "define at least one role",
  ),
}).strict();
export type Catalog = z.infer<typeof CatalogSchema>;

/**
 * Signal classes: the `failureClass` values of `@cachehit/agents`, plus
 * workflow-level outcomes a caller can report.
 */
export const SIGNAL_CLASSES = [
  "rate-limit",
  "quota",
  "auth",
  "model-unavailable",
  "timeout",
  "contract-violation",
  "infrastructure",
  "test-failure",
  "agent-declined",
  "unknown",
] as const;
export const SignalClassSchema = z.enum(SIGNAL_CLASSES);
export type SignalClass = z.infer<typeof SignalClassSchema>;

/** The only classes that move a role to its next tier. Bump the policy version when this changes. */
export const FALLBACK_TRIGGERS: ReadonlySet<SignalClass> = new Set<SignalClass>(
  ["rate-limit", "quota", "model-unavailable"],
);
export const POLICY_VERSION = "1";

/** A resolved tier: its index plus the candidate's settings. */
export const TierSchema = z.object({
  tier: z.number().int().nonnegative(),
  provider: ProviderSchema,
  model: z.string(),
  costClass: z.enum(["low", "medium", "high"]),
  toolProfile: z.enum(["readonly", "actor"]).nullable(),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).nullable(),
});
export type Tier = z.infer<typeof TierSchema>;

export const DecisionSchema = z.object({
  role: z.string(),
  signalClass: SignalClassSchema,
  attempt: z.number().int().positive(),
  disposition: z.enum(["advance", "no-fallback", "park"]),
  from: TierSchema,
  to: TierSchema.nullable(),
  reasons: z.array(z.string()),
  maxAttempts: z.number().int().positive(),
  policyVersion: z.string(),
  catalogVersion: z.string(),
  decidedAt: z.string(),
});
export type Decision = z.infer<typeof DecisionSchema>;

export const ResolutionSchema = z.object({
  workItem: z.string(),
  role: z.string(),
  catalogRole: z.string(),
  instanceName: z.string(),
  attempt: z.number().int().positive(),
  ...TierSchema.shape,
  disposition: z.enum(["initial", "advance", "no-fallback", "park"]),
  parked: z.boolean(),
  signalClass: SignalClassSchema.nullable(),
  signalSource: z.enum(["argument", "invocation"]).nullable(),
  fallbackRef: z.string().nullable(),
  reasons: z.array(z.string()),
  catalogVersion: z.string(),
  resolvedAt: z.string(),
});
export type Resolution = z.infer<typeof ResolutionSchema>;

/** Folds a concrete role name onto a catalog role; unmapped names pass through. */
export function catalogRoleFor(
  roleMap: Record<string, string>,
  role: string,
): string {
  return Object.hasOwn(roleMap, role) ? roleMap[role] : role;
}

/** The tier at `index` for `role`; throws on an unknown role or tier. */
export function tierAt(catalog: Catalog, role: string, index: number): Tier {
  const entry = Object.hasOwn(catalog.roles, role)
    ? catalog.roles[role]
    : undefined;
  if (!entry) {
    throw new Error(
      `role "${role}" is not in the catalog (roles: ${
        Object.keys(catalog.roles).join(", ")
      })`,
    );
  }
  const c = entry.tiers[index];
  if (!Number.isInteger(index) || !c) {
    throw new Error(
      `tier ${index} is out of range for role "${role}" (tiers 0..${
        entry.tiers.length - 1
      })`,
    );
  }
  return {
    tier: index,
    provider: c.provider,
    model: c.model,
    costClass: c.costClass,
    toolProfile: c.toolProfile ?? null,
    effort: c.effort ?? null,
  };
}

/** Index of `model` in a role's tiers, or null. */
export function tierOfModel(
  catalog: Catalog,
  role: string,
  model: string,
): number | null {
  const index = catalog.roles[role]?.tiers.findIndex((t) => t.model === model);
  return index === undefined || index < 0 ? null : index;
}

const label = (t: Tier) => `tier ${t.tier} (${t.provider}/${t.model})`;

/**
 * Decides one fallback. A non-trigger signal is `no-fallback`; a trigger
 * advances to the next tier unless the attempt bound or the tier list is
 * exhausted, which parks.
 */
export function decideFallback(
  catalog: Catalog,
  role: string,
  currentTier: number,
  signalClass: string,
  attempt: number,
  maxAttempts: number,
  decidedAt: string,
): Decision {
  const signal = SignalClassSchema.safeParse(signalClass);
  if (!signal.success) {
    throw new Error(
      `unknown signal class "${signalClass}" (known: ${
        SIGNAL_CLASSES.join(", ")
      })`,
    );
  }
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error(`attempt must be a positive integer, got ${attempt}`);
  }
  const from = tierAt(catalog, role, currentTier);
  const base = {
    role,
    signalClass: signal.data,
    attempt,
    from,
    maxAttempts,
    policyVersion: POLICY_VERSION,
    catalogVersion: catalog.version,
    decidedAt,
  };
  if (!FALLBACK_TRIGGERS.has(signal.data)) {
    return {
      ...base,
      disposition: "no-fallback",
      to: null,
      reasons: [
        `${signal.data} is not a fallback trigger (only ${
          [...FALLBACK_TRIGGERS].join(", ")
        }); the calling step handles it`,
      ],
    };
  }
  if (attempt >= maxAttempts) {
    return {
      ...base,
      disposition: "park",
      to: null,
      reasons: [
        `${signal.data} on attempt ${attempt} reached maxAttempts ${maxAttempts}; parked at ${
          label(from)
        }`,
      ],
    };
  }
  const tiers = catalog.roles[role].tiers;
  if (currentTier + 1 >= tiers.length) {
    return {
      ...base,
      disposition: "park",
      to: null,
      reasons: [
        `${signal.data} at ${
          label(from)
        } and role "${role}" has no further tier; parked`,
      ],
    };
  }
  const to = tierAt(catalog, role, currentTier + 1);
  return {
    ...base,
    disposition: "advance",
    to,
    reasons: [`${signal.data} at ${label(from)}; advance to ${label(to)}`],
  };
}

/** Name of the stored fallback decision for one (workItem, role, attempt). */
export const fallbackName = (workItem: string, role: string, attempt: number) =>
  `fallback-${workItem}-${role}-${attempt}`;

/** Name of the stored dispatch resolution for one (workItem, role, attempt). */
export const dispatchName = (workItem: string, role: string, attempt: number) =>
  `dispatch-${workItem}-${role}-${attempt}`;

/** The model, tier and settings a step should use for one attempt. */
export function resolveDispatch(
  catalog: Catalog,
  roleMap: Record<string, string>,
  args: {
    workItem: string;
    role: string;
    instanceName: string;
    attempt: number;
    currentTier: number;
    signalClass: string | null;
    signalSource: "argument" | "invocation" | null;
    maxAttempts: number;
  },
  resolvedAt: string,
): { resolution: Resolution; decision: Decision | null } {
  const catalogRole = catalogRoleFor(roleMap, args.role);
  const current = tierAt(catalog, catalogRole, args.currentTier);
  const base = {
    workItem: args.workItem,
    role: args.role,
    catalogRole,
    instanceName: args.instanceName,
    attempt: args.attempt,
  };
  const tail = { catalogVersion: catalog.version, resolvedAt };
  if (args.signalClass === null) {
    return {
      decision: null,
      resolution: {
        ...base,
        ...current,
        disposition: "initial",
        parked: false,
        signalClass: null,
        signalSource: null,
        fallbackRef: null,
        reasons: [`no failure signal; use ${label(current)}`],
        ...tail,
      },
    };
  }
  const decision = decideFallback(
    catalog,
    catalogRole,
    args.currentTier,
    args.signalClass,
    args.attempt,
    args.maxAttempts,
    resolvedAt,
  );
  const chosen = decision.to ?? current;
  return {
    decision,
    resolution: {
      ...base,
      ...chosen,
      disposition: decision.disposition,
      parked: decision.disposition === "park",
      signalClass: decision.signalClass,
      signalSource: args.signalSource,
      fallbackRef: fallbackName(args.workItem, args.role, args.attempt),
      reasons: decision.reasons,
      ...tail,
    },
  };
}

/** Invocation fields read from `@cachehit/agents` data. */
const InvocationSchema = z.object({
  startedAt: z.string(),
  success: z.boolean(),
  failureClass: z.string().nullable().optional(),
  model: z.string(),
  tags: z.record(z.string(), z.string()).default({}),
});

/**
 * The newest invocation tagged with this work item and phase, if it failed
 * with a classified failure: its failure class and model.
 */
export function latestFailure(
  records: { attributes?: unknown }[],
  workItem: string,
  phase: string,
  tagKeys: { workItem: string; phase: string },
): { signalClass: string; model: string } | null {
  const newest = records
    .map((r) => InvocationSchema.safeParse(r.attributes))
    .flatMap((r) => r.success ? [r.data] : [])
    .filter((i) =>
      i.tags[tagKeys.workItem] === workItem && i.tags[tagKeys.phase] === phase
    )
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  return newest && !newest.success && newest.failureClass
    ? { signalClass: newest.failureClass, model: newest.model }
    : null;
}

/** JSON with sorted keys, for comparing a stored record with a recomputed one. */
export function stableJson(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, v) =>
      v && typeof v === "object" && !Array.isArray(v)
        ? Object.fromEntries(
          Object.entries(v).filter(([, x]) => x !== undefined).sort((
            [a],
            [b],
          ) => a.localeCompare(b)),
        )
        : v,
  );
}
