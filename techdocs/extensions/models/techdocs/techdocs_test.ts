// SPDX-License-Identifier: Apache-2.0

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.19";
import { TarStream, type TarStreamInput } from "jsr:@std/tar@0.1.10/tar-stream";
import {
  createModelTestContext,
  withMockedFetch,
} from "@swamp-club/swamp-testing";
import { model } from "./techdocs.ts";

type Ctx = Parameters<typeof model.methods.sync.execute>[1];

const TOKEN = "test-token-value";
const HEAD = "1111111111111111111111111111111111111111";

const globalArgs = {
  siteUrl: "https://docs.example.com/",
  host: "gitlab.example.com",
  project: "group/docs",
  ref: "main",
  token: TOKEN,
  contentDir: "content",
  uglyUrls: false,
  taxonomies: ["tags"],
  outputFormats: {},
};

const FILES: Record<string, string> = {
  "content/_index.md": "---\ntitle: Home\n---\nWelcome.",
  "content/guides/deploy.md":
    "---\ntitle: Deploy\naliases: [/old-deploy/]\ntags: [k8s]\n---\nIntro.\n## Rollback\nUse rollout undo to roll back.\n",
  "content/guides/scale.md":
    "---\ntitle: Scale\ntags: [k8s]\n---\n## Replicas\nRaise the replica count.\n",
  "content/drafts/wip.md": "---\ndraft: true\n---\nSecret plan.",
  "content/guides/diagram.png": "binary",
  "README.md": "outside the content dir",
};

/** A GitLab-style archive: every entry under one root directory. */
async function archive(
  files: Record<string, string>,
): Promise<Uint8Array<ArrayBuffer>> {
  const encoder = new TextEncoder();
  const inputs: TarStreamInput[] = [
    { type: "directory", path: "docs-main-content/content" },
    ...Object.entries(files).map(([path, text]) => {
      const bytes = encoder.encode(text);
      return {
        type: "file" as const,
        path: `docs-main-content/${path}`,
        size: bytes.length,
        readable: ReadableStream.from([bytes]),
      };
    }),
  ];
  const stream = ReadableStream.from(inputs)
    .pipeThrough(new TarStream())
    .pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Fake GitLab answering the commit and archive endpoints. */
async function gitlab(head = HEAD) {
  const bytes = await archive(FILES);
  return (request: Request): Response => {
    const url = new URL(request.url);
    if (url.pathname.includes("/repository/commits/")) {
      return Response.json({ id: head });
    }
    if (url.pathname.endsWith("/repository/archive.tar.gz")) {
      return new Response(bytes);
    }
    return new Response("not found", { status: 404 });
  };
}

function context(
  overrides: Record<string, unknown> = {},
  storedResources: Record<string, Record<string, unknown>> = {},
) {
  const result = createModelTestContext({
    globalArgs: { ...globalArgs, ...overrides },
    storedResources,
  });
  return { ...result, context: result.context as unknown as Ctx };
}

/** Runs sync and returns the stored corpus, for seeding later calls. */
async function syncedCorpus(): Promise<Record<string, unknown>> {
  const { context: ctx, getWrittenResources } = context();
  await withMockedFetch(
    await gitlab(),
    () => model.methods.sync.execute({}, ctx),
  );
  return getWrittenResources().find((r) => r.specName === "corpus")!.data;
}

/** Latest data written for a spec; loosely typed for nested assertions. */
function written(
  list: { specName: string; data: Record<string, unknown> }[],
  spec: string,
  // deno-lint-ignore no-explicit-any
): Record<string, any> {
  // deno-lint-ignore no-explicit-any
  return list.find((r) => r.specName === spec)?.data as Record<string, any>;
}

Deno.test("sync downloads the archive and indexes only rendered Markdown pages", async () => {
  const { context: ctx, getWrittenResources } = context();
  const { calls } = await withMockedFetch(
    await gitlab(),
    () => model.methods.sync.execute({}, ctx),
  );
  assertEquals(calls.length, 2);
  assertEquals(
    calls[0].url,
    "https://gitlab.example.com/api/v4/projects/group%2Fdocs/repository/commits/main",
  );
  assertStringIncludes(calls[1].url, `sha=${HEAD}&path=content`);
  assertEquals(calls[1].headers["private-token"], TOKEN);

  const index = written(getWrittenResources(), "index");
  assertEquals(index.commit, HEAD);
  assertEquals(index.docCount, 3);
  assertEquals(index.skipped, [{ path: "drafts/wip.md", reason: "draft" }]);
  assertEquals(
    index.pages.map((p: { link: string }) => p.link).sort(),
    [
      "https://docs.example.com/",
      "https://docs.example.com/guides/deploy/",
      "https://docs.example.com/guides/scale/",
    ],
  );
  assertEquals(JSON.stringify(getWrittenResources()).includes(TOKEN), false);
});

Deno.test("search reuses the stored corpus while the branch head is unchanged", async () => {
  const corpus = await syncedCorpus();
  const { context: ctx, getWrittenResources } = context({}, { corpus });
  const { calls } = await withMockedFetch(
    await gitlab(),
    () =>
      model.methods.search.execute(
        { query: "rollback", limit: 10, refresh: "auto" },
        ctx,
      ),
  );
  assertEquals(calls.length, 1);
  const search = written(getWrittenResources(), "search");
  assertEquals(
    search.hits[0].link,
    "https://docs.example.com/guides/deploy/#rollback",
  );
  assertEquals(search.hits[0].heading, "Rollback");
  assertStringIncludes(search.hits[0].snippet, "roll back");
  assertEquals(written(getWrittenResources(), "corpus"), undefined);
});

Deno.test("search re-syncs when the branch head moved", async () => {
  const corpus = await syncedCorpus();
  const { context: ctx, getWrittenResources } = context({}, { corpus });
  const { calls } = await withMockedFetch(
    await gitlab("2".repeat(40)),
    () =>
      model.methods.search.execute(
        { query: "replica", limit: 10, refresh: "auto" },
        ctx,
      ),
  );
  assertEquals(calls.length, 3);
  assertEquals(written(getWrittenResources(), "index").commit, "2".repeat(40));
});

Deno.test("refresh never makes no requests, unless settings changed", async () => {
  const corpus = await syncedCorpus();
  const same = context({}, { corpus });
  const none = await withMockedFetch(
    await gitlab(),
    () =>
      model.methods.search.execute(
        { query: "replica", limit: 10, refresh: "never" },
        same.context,
      ),
  );
  assertEquals(none.calls.length, 0);

  const changed = context({ uglyUrls: true }, { corpus });
  const resync = await withMockedFetch(
    await gitlab(),
    () =>
      model.methods.search.execute(
        { query: "replica", limit: 10, refresh: "never" },
        changed.context,
      ),
  );
  assertEquals(resync.calls.length, 2);
  assertEquals(
    written(changed.getWrittenResources(), "search").hits[0].link,
    "https://docs.example.com/guides/scale.html#replicas",
  );
});

Deno.test("search applies taxonomy filters", async () => {
  const corpus = await syncedCorpus();
  const { context: ctx, getWrittenResources } = context({}, { corpus });
  await model.methods.search.execute({
    query: "welcome",
    limit: 10,
    refresh: "never",
    taxonomyTerms: { tags: ["k8s"] },
  }, ctx);
  const search = written(getWrittenResources(), "search");
  assert(
    search.hits.every((h: { path: string }) => h.path.startsWith("guides/")),
  );
});

Deno.test("get_doc finds pages by URL with fragment, alias and content path", async () => {
  const corpus = await syncedCorpus();
  for (
    const page of [
      "https://docs.example.com/guides/deploy/#rollback",
      "/old-deploy",
      "content/guides/deploy.md",
      "guides/deploy.md#rollback",
    ]
  ) {
    const { context: ctx, getWrittenResources } = context({}, { corpus });
    await model.methods.get_doc.execute({ page, refresh: "never" }, ctx);
    const doc = written(getWrittenResources(), "doc");
    assertEquals(doc.path, "guides/deploy.md", page);
    assertEquals(
      doc.editUrl,
      "https://gitlab.example.com/group/docs/-/edit/main/content/guides/deploy.md",
    );
    assertEquals(doc.related.map((r: { path: string }) => r.path), [
      "guides/scale.md",
    ]);
    if (page.includes("#")) {
      assertEquals(doc.section, "Rollback");
      assertEquals(doc.content, "Use rollout undo to roll back.");
    } else {
      assertEquals(doc.section, null);
      assertStringIncludes(doc.content, "## Rollback");
    }
  }
});

Deno.test("get_doc explains unknown pages and sections", async () => {
  const corpus = await syncedCorpus();
  const { context: ctx } = context({}, { corpus });
  await assertRejects(
    () =>
      model.methods.get_doc.execute({
        page: "/guides/deploy-x/",
        refresh: "never",
      }, ctx),
    Error,
    "closest: guides/deploy.md",
  );
  await assertRejects(
    () =>
      model.methods.get_doc.execute(
        { page: "guides/deploy.md", section: "nope", refresh: "never" },
        ctx,
      ),
    Error,
    "sections: Rollback",
  );
  await assertRejects(
    () =>
      model.methods.get_doc.execute({
        page: "https://other.example.org/x",
        refresh: "never",
      }, ctx),
    Error,
    "not the configured site",
  );
});

Deno.test("build_context writes cited Markdown within the budget", async () => {
  const corpus = await syncedCorpus();
  const { context: ctx, getWrittenResources } = context({}, { corpus });
  await model.methods.build_context.execute({
    query: "rollback replicas",
    maxTokens: 2000,
    maxSections: 5,
    refresh: "never",
  }, ctx);
  const bundle = written(getWrittenResources(), "context");
  assertEquals(bundle.commit, HEAD);
  assert(bundle.estimatedTokens <= 2000);
  assertStringIncludes(
    bundle.markdown,
    "Source: https://docs.example.com/guides/",
  );
  assert(bundle.sources.length >= 1);
});

Deno.test("a local checkout is indexed without GitLab settings", async () => {
  const root = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${root}/content/guides`, { recursive: true });
    await Deno.writeTextFile(
      `${root}/content/guides/local.md`,
      "---\ntitle: Local page\n---\n## Notes\nOffline notes.",
    );
    const { context: ctx, getWrittenResources } = context({
      host: undefined,
      project: undefined,
      token: undefined,
      localPath: root,
    });
    const { calls } = await withMockedFetch(
      [],
      () =>
        model.methods.search.execute(
          { query: "offline", limit: 5, refresh: "auto" },
          ctx,
        ),
    );
    assertEquals(calls.length, 0);
    const index = written(getWrittenResources(), "index");
    assertEquals([index.source, index.commit, index.ref], [
      "local",
      null,
      null,
    ]);
    assertEquals(
      written(getWrittenResources(), "search").hits[0].path,
      "guides/local.md",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("errors name the problem but never the token", async () => {
  const { context: ctx } = context();
  const error = await assertRejects(
    () =>
      withMockedFetch(
        [new Response("no", { status: 401 })],
        () => model.methods.sync.execute({}, ctx),
      ),
    Error,
    "401",
  );
  assertStringIncludes(error.message, "swamp vault put");
  assertEquals(error.message.includes(TOKEN), false);

  const missing = context({ host: undefined, token: undefined });
  await assertRejects(
    () => model.methods.sync.execute({}, missing.context),
    Error,
    "Set host, token (or localPath)",
  );
});
