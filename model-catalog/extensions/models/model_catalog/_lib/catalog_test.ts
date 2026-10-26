// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertThrows } from "jsr:@std/assert@1.0.19";
import {
  CatalogSchema,
  decideFallback,
  latestFailure,
  resolveDispatch,
  stableJson,
  tierAt,
  tierOfModel,
} from "./catalog.ts";
import { CATALOG } from "./fixture_test.ts";

const NOW = "2026-10-26T12:00:00.000Z";

Deno.test("CatalogSchema defaults the provider to kiro and rejects bad tables", () => {
  assertEquals(CATALOG.roles.implementer.tiers[0].provider, "kiro");
  const bad = [
    { version: "1", roles: {} },
    {
      version: "1",
      roles: {
        r: { tiers: [{ provider: "claude", model: "x", costClass: "low" }] },
      },
    },
    {
      version: "1",
      roles: {
        r: {
          tiers: [{ model: "x", costClass: "low" }, {
            model: "x",
            costClass: "high",
          }],
        },
      },
    },
    {
      version: "1",
      roles: { "bad role": { tiers: [{ model: "x", costClass: "low" }] } },
    },
  ];
  for (const catalog of bad) {
    assertEquals(
      CatalogSchema.safeParse(catalog).success,
      false,
      JSON.stringify(catalog),
    );
  }
});

Deno.test("tierAt returns the candidate settings and fails closed", () => {
  assertEquals(tierAt(CATALOG, "implementer", 1), {
    tier: 1,
    provider: "kiro",
    model: "claude-sonnet-4.6",
    costClass: "medium",
    toolProfile: null,
    effort: "high",
  });
  assertThrows(() => tierAt(CATALOG, "tester", 0), Error, "not in the catalog");
  assertThrows(() => tierAt(CATALOG, "reviewer", 1), Error, "out of range");
  assertThrows(
    () => tierAt(CATALOG, "constructor", 0),
    Error,
    "not in the catalog",
  );
  assertEquals(tierOfModel(CATALOG, "implementer", "claude-opus-4.8"), 2);
  assertEquals(tierOfModel(CATALOG, "implementer", "gpt-x"), null);
});

Deno.test("decideFallback advances only on rate-limit, quota and model-unavailable", () => {
  for (const signal of ["rate-limit", "quota", "model-unavailable"]) {
    const d = decideFallback(CATALOG, "implementer", 0, signal, 1, 3, NOW);
    assertEquals(d.disposition, "advance", signal);
    assertEquals(d.to?.model, "claude-sonnet-4.6");
  }
  for (
    const signal of ["contract-violation", "timeout", "auth", "test-failure"]
  ) {
    const d = decideFallback(CATALOG, "implementer", 0, signal, 1, 3, NOW);
    assertEquals(d.disposition, "no-fallback", signal);
    assertEquals(d.to, null);
  }
  assertThrows(
    () => decideFallback(CATALOG, "implementer", 0, "session-limit", 1, 3, NOW),
    Error,
    "unknown signal class",
  );
});

Deno.test("decideFallback parks at the attempt bound and at the last tier", () => {
  assertEquals(
    decideFallback(CATALOG, "implementer", 0, "quota", 3, 3, NOW).disposition,
    "park",
  );
  const last = decideFallback(CATALOG, "reviewer", 0, "rate-limit", 1, 3, NOW);
  assertEquals(last.disposition, "park");
  assertEquals(last.from.model, "claude-opus-4.8");
});

const args = {
  workItem: "WI-1",
  role: "build",
  instanceName: "kiro",
  attempt: 1,
  currentTier: 0,
  signalClass: null,
  signalSource: null,
  maxAttempts: 3,
};
const roleMap = { build: "implementer" };

Deno.test("resolveDispatch picks tier 0 with no signal and folds the role", () => {
  const { resolution, decision } = resolveDispatch(CATALOG, roleMap, args, NOW);
  assertEquals(decision, null);
  assertEquals(resolution.catalogRole, "implementer");
  assertEquals(resolution.model, "claude-haiku-4.5");
  assertEquals(resolution.toolProfile, "actor");
  assertEquals(resolution.disposition, "initial");
  assertEquals(resolution.fallbackRef, null);
});

Deno.test("resolveDispatch moves to the next tier after a quota failure", () => {
  const { resolution, decision } = resolveDispatch(CATALOG, roleMap, {
    ...args,
    attempt: 2,
    signalClass: "quota",
    signalSource: "invocation",
  }, NOW);
  assertEquals(decision?.disposition, "advance");
  assertEquals(resolution.tier, 1);
  assertEquals(resolution.model, "claude-sonnet-4.6");
  assertEquals(resolution.effort, "high");
  assertEquals(resolution.parked, false);
  assertEquals(resolution.fallbackRef, "fallback-WI-1-build-2");
});

Deno.test("resolveDispatch stays on the tier for a non-trigger and parks when exhausted", () => {
  const stay = resolveDispatch(CATALOG, roleMap, {
    ...args,
    currentTier: 1,
    signalClass: "contract-violation",
    signalSource: "argument",
  }, NOW).resolution;
  assertEquals([stay.disposition, stay.tier], ["no-fallback", 1]);
  const park = resolveDispatch(CATALOG, roleMap, {
    ...args,
    currentTier: 2,
    signalClass: "rate-limit",
    signalSource: "argument",
  }, NOW).resolution;
  assertEquals([park.disposition, park.parked, park.tier], ["park", true, 2]);
});

Deno.test("latestFailure reads the newest matching @cachehit/agents invocation", () => {
  const inv = (startedAt: string, success: boolean, extra = {}) => ({
    attributes: {
      startedAt,
      success,
      failureClass: success ? null : "rate-limit",
      model: "claude-haiku-4.5",
      tags: { workItem: "WI-1", phase: "build" },
      ...extra,
    },
  });
  const keys = { workItem: "workItem", phase: "phase" };
  assertEquals(
    latestFailure(
      [inv("2026-10-26T10:00:00Z", true), inv("2026-10-26T11:00:00Z", false)],
      "WI-1",
      "build",
      keys,
    ),
    { signalClass: "rate-limit", model: "claude-haiku-4.5" },
  );
  assertEquals(
    latestFailure(
      [inv("2026-10-26T11:00:00Z", false), inv("2026-10-26T12:00:00Z", true)],
      "WI-1",
      "build",
      keys,
    ),
    null,
  );
  assertEquals(
    latestFailure(
      [inv("2026-10-26T11:00:00Z", false, {
        tags: { workItem: "WI-2", phase: "build" },
      })],
      "WI-1",
      "build",
      keys,
    ),
    null,
  );
  assertEquals(
    latestFailure([{ attributes: { unrelated: true } }], "WI-1", "build", keys),
    null,
  );
});

Deno.test("stableJson ignores key order and undefined", () => {
  assertEquals(
    stableJson({ b: 1, a: { d: 2, c: undefined } }),
    stableJson({ a: { d: 2 }, b: 1 }),
  );
});
