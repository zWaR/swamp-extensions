// SPDX-License-Identifier: Apache-2.0

import { assert, assertEquals } from "jsr:@std/assert@1.0.19";
import type { Doc } from "./content.ts";
import {
  bestPerDoc,
  buildContext,
  filterDocs,
  searchChunks,
  snippet,
} from "./search.ts";

function doc(
  path: string,
  title: string,
  sections: [string, string][],
  taxonomies: Record<string, string[]> = {},
): Doc {
  return {
    path,
    url: `/${path.replace(/\.md$/, "")}/`,
    title,
    description: "",
    weight: null,
    aliases: [],
    taxonomies,
    body: sections.map(([h, t]) => `## ${h}\n${t}`).join("\n"),
    headings: sections.map(([h]) => h),
    chunks: sections.map(([heading, text]) => ({
      heading,
      anchor: heading.toLowerCase(),
      text,
    })),
  };
}

const docs = [
  doc("guides/how-to/deploy.md", "Deploy the service", [
    ["Prerequisites", "You need cluster access and a kubeconfig."],
    ["Rollback", "Use the rollout undo command to roll back a deployment."],
  ], { tags: ["kubernetes"] }),
  doc("guides/reference/glossary.md", "Glossary", [
    [
      "Terms",
      "Deployment means shipping a build. Cluster is a group of nodes.",
    ],
  ], { tags: ["reference"] }),
  doc("about/team.md", "Team", [["Members", "Who we are."]]),
];

Deno.test("filterDocs applies path and case-insensitive taxonomy filters", () => {
  const paths = (f: Parameters<typeof filterDocs>[1]) =>
    filterDocs(docs, f).map((d) => d.path);
  assertEquals(paths({ pathPrefix: "guides/" }).length, 2);
  assertEquals(paths({ pathContains: "/how-to/" }), [
    "guides/how-to/deploy.md",
  ]);
  assertEquals(paths({ taxonomies: { tags: ["Kubernetes"] } }), [
    "guides/how-to/deploy.md",
  ]);
  assertEquals(paths({ taxonomies: { tags: [] } }).length, 3);
  assertEquals(paths({ taxonomies: { missing: ["x"] } }), []);
});

Deno.test("searchChunks ranks the section that matches best", () => {
  const [top] = searchChunks(docs, "rollback deployment", {});
  assertEquals(top.doc.path, "guides/how-to/deploy.md");
  assertEquals(top.chunk.anchor, "rollback");
});

Deno.test("searchChunks tolerates typos and prefixes", () => {
  assertEquals(searchChunks(docs, "glosary", {})[0].doc.title, "Glossary");
  assertEquals(
    searchChunks(docs, "kubeconf", {})[0].chunk.anchor,
    "prerequisites",
  );
});

Deno.test("searchChunks falls back to any-term matching", () => {
  const matches = searchChunks(docs, "members zzzzzzzz", {});
  assertEquals(matches[0].doc.path, "about/team.md");
});

Deno.test("searchChunks respects filters", () => {
  const matches = searchChunks(docs, "cluster", {
    pathPrefix: "guides/reference",
  });
  assertEquals(matches.map((m) => m.doc.path), [
    "guides/reference/glossary.md",
  ]);
});

Deno.test("bestPerDoc keeps one match per page in rank order", () => {
  const pages = bestPerDoc(searchChunks(docs, "cluster deployment", {}));
  assertEquals(new Set(pages.map((p) => p.doc.path)).size, pages.length);
});

Deno.test("snippet centres on the first matching term", () => {
  const text = `${"a ".repeat(300)}needle ${"b ".repeat(300)}`;
  const s = snippet(text, "needle", 60);
  assert(s.includes("needle"));
  assert(s.startsWith("…") && s.endsWith("…"));
  assertEquals(snippet("short text", "absent"), "short text");
});

Deno.test("buildContext cites sources and stays within the token budget", () => {
  const long = doc("big.md", "Big", [["Huge", "word ".repeat(20_000)]]);
  const matches = searchChunks([long, ...docs], "word deployment cluster", {});
  const bundle = buildContext(matches, "q", {
    maxTokens: 1000,
    maxSections: 10,
    link: (d, c) => `https://docs.example.com${d.url}#${c.anchor}`,
    commit: "abc123",
  });
  assert(bundle.estimatedTokens <= 1000);
  assert(bundle.truncated);
  assert(bundle.markdown.includes("Source commit: abc123"));
  assert(bundle.markdown.includes(`Source: ${bundle.sources[0].link}`));
});

Deno.test("buildContext stops at maxSections", () => {
  const matches = searchChunks(docs, "cluster deployment members", {});
  const bundle = buildContext(matches, "q", {
    maxTokens: 50_000,
    maxSections: 1,
    link: () => "x",
    commit: null,
  });
  assertEquals(bundle.sources.length, 1);
  assertEquals(bundle.truncated, matches.length > 1);
  assert(!bundle.markdown.includes("Source commit"));
});
