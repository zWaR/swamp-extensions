// SPDX-License-Identifier: Apache-2.0

import { assertEquals, assertThrows } from "jsr:@std/assert@1.0.19";
import {
  anchorize,
  chunkBody,
  cleanText,
  pageUrl,
  parseDoc,
  splitFrontMatter,
} from "./content.ts";

const options = { uglyUrls: false, taxonomies: ["tags", "categories"] };

Deno.test("splitFrontMatter reads YAML, TOML and files without front matter", () => {
  assertEquals(
    splitFrontMatter("---\ntitle: Setup\nweight: 2\n---\n# Body\n"),
    { data: { title: "Setup", weight: 2 }, body: "# Body\n" },
  );
  assertEquals(
    splitFrontMatter('+++\ntitle = "Setup"\n+++\nBody'),
    { data: { title: "Setup" }, body: "Body" },
  );
  assertEquals(splitFrontMatter("\uFEFF---\n---\nBody"), {
    data: {},
    body: "Body",
  });
  assertEquals(splitFrontMatter("Just text\n---\nrule"), {
    data: {},
    body: "Just text\n---\nrule",
  });
  assertThrows(
    () => splitFrontMatter("---\ntitle: x\n"),
    Error,
    "unterminated",
  );
});

Deno.test("anchorize matches Hugo's GitHub-style heading IDs", () => {
  assertEquals(anchorize("Install the CLI"), "install-the-cli");
  assertEquals(anchorize("What's `new` in v2.0?"), "whats-new-in-v20");
  assertEquals(
    anchorize("[Linked](https://example.com) title"),
    "linked-title",
  );
  assertEquals(anchorize("snake_case and-dash"), "snake_case-and-dash");
});

Deno.test("cleanText drops shortcode delimiters and comments, keeps inner text", () => {
  assertEquals(
    cleanText(
      '{{< alert title="Note" >}}Keep me{{< /alert >}}\n<!-- hidden -->\n{{% faq %}}',
    ),
    "Keep me",
  );
});

Deno.test("chunkBody splits at H1/H2 outside fences and dedupes anchors", () => {
  const body = [
    "Intro text.",
    "## Install",
    "Run it.",
    "```bash",
    "## not a heading",
    "```",
    "### Detail",
    "More.",
    "## Install",
    "Again.",
    "## Custom {#my-id}",
    "Text.",
  ].join("\n");
  const { chunks, headings } = chunkBody(body, "Page");
  assertEquals(chunks.map((c) => [c.heading, c.anchor]), [
    ["Page", ""],
    ["Install", "install"],
    ["Install", "install-1"],
    ["Custom", "my-id"],
  ]);
  assertEquals(headings, ["Install", "Detail", "Install", "Custom"]);
  assertEquals(chunks[1].text.includes("## not a heading"), true);
  assertEquals(chunks[1].text.includes("### Detail"), true);
});

Deno.test("chunkBody omits an empty lead-in before the first heading", () => {
  const { chunks } = chunkBody("## Only\nText", "Page");
  assertEquals(chunks.map((c) => c.anchor), ["only"]);
});

Deno.test("pageUrl follows Hugo pretty and ugly URL rules", () => {
  const cases: [string, Record<string, unknown>, boolean, string][] = [
    ["_index.md", {}, false, "/"],
    ["_index.md", {}, true, "/index.html"],
    ["guides/_index.md", {}, false, "/guides/"],
    ["guides/_index.md", {}, true, "/guides/index.html"],
    ["guides/setup.md", {}, false, "/guides/setup/"],
    ["guides/setup.md", {}, true, "/guides/setup.html"],
    ["guides/bundle/index.md", {}, false, "/guides/bundle/"],
    ["guides/bundle/index.md", {}, true, "/guides/bundle.html"],
    ["Guides/My Page.md", {}, true, "/guides/my-page.html"],
    ["notes/pkg:lib_1.2.md", {}, true, "/notes/pkglib_1.2.html"],
    ["guides/setup.md", { slug: "start" }, false, "/guides/start/"],
    ["guides/_index.md", { slug: "ignored" }, false, "/guides/"],
    ["guides/setup.md", { url: "custom/path/" }, true, "/custom/path/"],
  ];
  for (const [path, fm, ugly, want] of cases) {
    assertEquals(pageUrl(path, fm, ugly), want, path);
  }
});

Deno.test("pageUrl uses a custom output format baseName for list pages", () => {
  const formats = { reveal: "reveal" };
  assertEquals(
    pageUrl("talks/_index.md", { outputs: ["Reveal"] }, true, formats),
    "/talks/reveal.html",
  );
  assertEquals(
    pageUrl("talks/_index.md", { outputs: ["HTML"] }, true, formats),
    "/talks/index.html",
  );
});

Deno.test("parseDoc skips drafts, exclude_search and unrendered pages", () => {
  for (
    const [fm, reason] of [
      ["draft: true", "draft"],
      ["exclude_search: true", "exclude_search"],
      ["build:\n  render: never", "not rendered"],
    ]
  ) {
    assertEquals(parseDoc("a.md", `---\n${fm}\n---\nx`, options), {
      skipped: reason,
    });
  }
  const bad = parseDoc("a.md", "---\ntitle: [\n---\nx", options);
  assertEquals(
    "skipped" in bad && bad.skipped.startsWith("front matter"),
    true,
  );
});

Deno.test("parseDoc reads metadata and normalises taxonomies", () => {
  const result = parseDoc(
    "guides/setup.md",
    "---\ntitle: Setup\ndescription: How to\nweight: 3\naliases: /old\ntags: [a, b]\ncategories: ops\nother: [x]\n---\n## Step\nDo it.\n",
    options,
  );
  if (!("doc" in result)) throw new Error("expected a doc");
  const { doc } = result;
  assertEquals(doc.url, "/guides/setup/");
  assertEquals(doc.title, "Setup");
  assertEquals(doc.description, "How to");
  assertEquals(doc.weight, 3);
  assertEquals(doc.aliases, ["/old"]);
  assertEquals(doc.taxonomies, { tags: ["a", "b"], categories: ["ops"] });
  assertEquals(doc.chunks, [{
    heading: "Step",
    anchor: "step",
    text: "Do it.",
  }]);
});

Deno.test("parseDoc falls back to the file or bundle name for the title", () => {
  const page = parseDoc("guides/setup.md", "Body", options);
  const bundle = parseDoc("guides/bundle/index.md", "Body", options);
  assertEquals("doc" in page && page.doc.title, "setup");
  assertEquals("doc" in bundle && bundle.doc.title, "bundle");
});
