// SPDX-License-Identifier: Apache-2.0

import { type Catalog, CatalogSchema } from "./catalog.ts";

/** Catalog shared by the tests. */
export const CATALOG: Catalog = CatalogSchema.parse({
  version: "test-1",
  roles: {
    implementer: {
      tiers: [
        {
          model: "claude-haiku-4.5",
          costClass: "low",
          toolProfile: "actor",
        },
        { model: "claude-sonnet-4.6", costClass: "medium", effort: "high" },
        { model: "claude-opus-4.8", costClass: "high" },
      ],
    },
    reviewer: {
      tiers: [{
        model: "claude-opus-4.8",
        costClass: "high",
        toolProfile: "readonly",
      }],
    },
  },
});
