/**
 * Search and context building over a Hugo (for example Docsy) documentation
 * site, read from its source repository in GitLab or a local checkout.
 *
 * `sync` downloads the content directory, parses front matter and splits each
 * page into heading sections. `search`, `get_doc` and `build_context` work on
 * that local copy and re-sync first when the branch head has moved.
 *
 * @module
 */
// SPDX-License-Identifier: Apache-2.0

import { z } from "npm:zod@4.6.5";
import { type Chunk, type Doc, parseDoc } from "./_lib/content.ts";
import {
  bestPerDoc,
  buildContext,
  type Filters,
  searchChunks,
  snippet,
} from "./_lib/search.ts";
import {
  gitlabHead,
  gitlabSnapshot,
  type GitLabSource,
  localSnapshot,
} from "./_lib/source.ts";

const GlobalArgsSchema = z.object({
  siteUrl: z.string().url().describe(
    "Published site root, for example https://docs.example.com",
  ),
  host: z.string().min(1).optional().describe(
    "GitLab host name without scheme, for example gitlab.example.com",
  ),
  project: z.string().min(1).optional().describe(
    "GitLab project path (group/project) or numeric ID",
  ),
  ref: z.string().min(1).default("main").describe("Branch, tag or commit"),
  token: z.string().min(1).optional().meta({ sensitive: true }).describe(
    'GitLab token with read_repository or read_api scope; use ${{ vault.get("<vault>", "<KEY>") }}',
  ),
  localPath: z.string().min(1).optional().describe(
    "Read a local checkout instead of GitLab (host, project and token are then unused)",
  ),
  contentDir: z.string().min(1).default("content").describe(
    "Hugo content directory, relative to the repository root",
  ),
  uglyUrls: z.boolean().default(false).describe(
    "Set to match the site's Hugo uglyURLs setting",
  ),
  taxonomies: z.array(z.string().min(1)).default(["categories", "tags"])
    .describe("Front matter keys to index and filter on as taxonomies"),
  outputFormats: z.record(z.string(), z.string().min(1)).default({}).describe(
    'Custom Hugo output formats used as a page\'s primary output, name to baseName, for example {"reveal":"reveal"}',
  ),
});
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const RefreshSchema = z.enum(["auto", "always", "never"]).default("auto")
  .describe(
    "auto: re-sync when the branch head moved (local: always re-read); always: re-sync; never: use stored data",
  );

const FilterArgs = {
  pathPrefix: z.string().optional().describe(
    "Only pages whose content path starts with this, for example guides/",
  ),
  pathContains: z.string().optional().describe(
    "Only pages whose content path contains this, for example /how-to/",
  ),
  taxonomyTerms: z.record(z.string(), z.array(z.string())).optional().describe(
    'Taxonomy filters, for example {"tags":["kubernetes"]}; each key must match one term',
  ),
};

const ChunkSchema = z.object({
  heading: z.string(),
  anchor: z.string(),
  text: z.string(),
});

const DocSchema = z.object({
  path: z.string(),
  url: z.string(),
  title: z.string(),
  description: z.string(),
  weight: z.number().nullable(),
  aliases: z.array(z.string()),
  taxonomies: z.record(z.string(), z.array(z.string())),
  body: z.string(),
  headings: z.array(z.string()),
  chunks: z.array(ChunkSchema),
});

const CorpusSchema = z.object({
  commit: z.string().nullable(),
  settings: z.string(),
  indexedAt: z.string(),
  docs: z.array(DocSchema),
});
type Corpus = z.infer<typeof CorpusSchema>;

const PageRefSchema = z.object({
  path: z.string(),
  title: z.string(),
  link: z.string(),
});

const IndexSchema = z.object({
  source: z.enum(["gitlab", "local"]),
  ref: z.string().nullable(),
  commit: z.string().nullable(),
  indexedAt: z.string(),
  docCount: z.number(),
  chunkCount: z.number(),
  skipped: z.array(z.object({ path: z.string(), reason: z.string() })),
  pages: z.array(PageRefSchema),
});

const SearchSchema = z.object({
  query: z.string(),
  commit: z.string().nullable(),
  total: z.number(),
  hits: z.array(z.object({
    path: z.string(),
    title: z.string(),
    heading: z.string(),
    link: z.string(),
    score: z.number(),
    snippet: z.string(),
    taxonomies: z.record(z.string(), z.array(z.string())),
  })),
});

const DocResultSchema = DocSchema.omit({ chunks: true }).extend({
  link: z.string(),
  editUrl: z.string().nullable(),
  commit: z.string().nullable(),
  section: z.string().nullable(),
  content: z.string(),
  related: z.array(PageRefSchema),
});

const ContextSchema = z.object({
  query: z.string(),
  commit: z.string().nullable(),
  estimatedTokens: z.number(),
  truncated: z.boolean(),
  sources: z.array(z.object({
    title: z.string(),
    heading: z.string(),
    path: z.string(),
    link: z.string(),
    score: z.number(),
  })),
  markdown: z.string(),
});

type Handle = { name: string; version?: number };
type Ctx = {
  globalArgs: GlobalArgs;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<Handle>;
  readResource: (name: string) => Promise<Record<string, unknown> | null>;
  logger: { info: (message: string, fields?: Record<string, unknown>) => void };
};

/** GitLab settings, or an error naming what is missing. */
function gitlabSource(g: GlobalArgs): GitLabSource {
  const missing = (["host", "project", "token"] as const).filter((k) => !g[k]);
  if (missing.length) {
    throw new Error(
      `Set ${
        missing.join(", ")
      } (or localPath) on the model's global arguments`,
    );
  }
  return {
    host: g.host!,
    project: g.project!,
    ref: g.ref,
    token: g.token!,
    contentDir: g.contentDir,
  };
}

/** Settings that change parsed output; a stored corpus with others is stale. */
const settingsKey = (g: GlobalArgs): string =>
  JSON.stringify([
    g.localPath ?? `${g.host}/${g.project}@${g.ref}`,
    g.contentDir,
    g.uglyUrls,
    g.taxonomies,
    g.outputFormats,
  ]);

/** Absolute link to a page, optionally to one of its headings. */
function linkTo(g: GlobalArgs, doc: Doc, anchor = ""): string {
  return `${g.siteUrl.replace(/\/+$/, "")}${doc.url}${
    anchor ? `#${anchor}` : ""
  }`;
}

/** Downloads and parses all content, then stores `index` and `corpus`. */
async function sync(ctx: Ctx): Promise<{ corpus: Corpus; handles: Handle[] }> {
  const g = ctx.globalArgs;
  const snapshot = g.localPath
    ? await localSnapshot(g.localPath, g.contentDir)
    : await gitlabSnapshot(gitlabSource(g));
  const docs: Doc[] = [];
  const skipped: { path: string; reason: string }[] = [];
  for (const file of snapshot.files) {
    const result = parseDoc(file.path, file.content, g);
    if ("doc" in result) docs.push(result.doc);
    else skipped.push({ path: file.path, reason: result.skipped });
  }
  const indexedAt = new Date().toISOString();
  const corpus: Corpus = {
    commit: snapshot.commit,
    settings: settingsKey(g),
    indexedAt,
    docs,
  };
  const chunkCount = docs.reduce((n, d) => n + d.chunks.length, 0);
  const index = await ctx.writeResource("index", "index", {
    source: g.localPath ? "local" : "gitlab",
    ref: g.localPath ? null : g.ref,
    commit: snapshot.commit,
    indexedAt,
    docCount: docs.length,
    chunkCount,
    skipped,
    pages: docs.map((d) => ({
      path: d.path,
      title: d.title,
      link: linkTo(g, d),
    })),
  });
  const stored = await ctx.writeResource("corpus", "corpus", corpus);
  ctx.logger.info(
    "Indexed {docs} pages ({chunks} sections), skipped {skipped}",
    {
      docs: docs.length,
      chunks: chunkCount,
      skipped: skipped.length,
    },
  );
  return { corpus, handles: [index, stored] };
}

/** The stored corpus, re-synced first according to `refresh`. */
async function ensureCorpus(
  ctx: Ctx,
  refresh: "auto" | "always" | "never",
): Promise<{ corpus: Corpus; handles: Handle[] }> {
  const stored = await ctx.readResource("corpus") as Corpus | null;
  const g = ctx.globalArgs;
  const usable = stored && stored.settings === settingsKey(g);
  if (usable && refresh === "never") return { corpus: stored, handles: [] };
  if (usable && refresh === "auto" && !g.localPath) {
    const head = await gitlabHead(gitlabSource(g));
    if (head === stored.commit) return { corpus: stored, handles: [] };
  }
  return await sync(ctx);
}

/** Method filter arguments; `taxonomyTerms` avoids the `taxonomies` global. */
type FilterInput = Omit<Filters, "taxonomies"> & {
  taxonomyTerms?: Record<string, string[]>;
};

/** Splits the shared filter arguments off a method's arguments. */
const filtersOf = (args: FilterInput): Filters => ({
  pathPrefix: args.pathPrefix,
  pathContains: args.pathContains,
  taxonomies: args.taxonomyTerms,
});

/** Strips the scheme/host, query and Hugo index suffixes from a page reference. */
function normaliseRef(value: string, siteUrl: string): string {
  let ref = value.trim();
  if (/^https?:\/\//i.test(ref)) {
    const url = new URL(ref);
    const site = new URL(siteUrl);
    if (url.host !== site.host) {
      throw new Error(`${url.host} is not the configured site ${site.host}`);
    }
    ref = url.pathname;
  }
  return ref.split(/[?#]/)[0]
    .replace(/(\/index)?\.html$/i, "")
    .replace(/\/+$/, "")
    .replace(/^\/+/, "")
    .toLowerCase();
}

/** Finds a page by content path, site URL or alias. */
function findDoc(docs: Doc[], page: string, g: GlobalArgs): Doc | undefined {
  const contentPrefix = `${g.contentDir.replace(/^\/+|\/+$/g, "")}/`;
  const asPath = page.trim().split("#")[0].replace(/^\/+/, "").toLowerCase();
  const byPath = docs.find((d) => {
    const path = d.path.toLowerCase();
    return path === asPath ||
      `${contentPrefix.toLowerCase()}${path}` === asPath;
  });
  if (byPath) return byPath;
  const wanted = normaliseRef(page, g.siteUrl);
  return docs.find((d) =>
    [d.url, ...d.aliases].some((u) => normaliseRef(u, g.siteUrl) === wanted)
  );
}

/** Pages that share the most taxonomy terms with `doc`. */
function related(docs: Doc[], doc: Doc, g: GlobalArgs) {
  const terms = new Set(
    Object.entries(doc.taxonomies).flatMap(([k, v]) =>
      v.map((t) => `${k}:${t}`)
    ),
  );
  if (!terms.size) return [];
  return docs
    .filter((d) => d.path !== doc.path)
    .map((d) => ({
      d,
      shared: Object.entries(d.taxonomies)
        .flatMap(([k, v]) => v.map((t) => `${k}:${t}`))
        .filter((t) => terms.has(t)).length,
    }))
    .filter((x) => x.shared > 0)
    .sort((a, b) => b.shared - a.shared || a.d.title.localeCompare(b.d.title))
    .slice(0, 5)
    .map(({ d }) => ({ path: d.path, title: d.title, link: linkTo(g, d) }));
}

/** GitLab web editor URL for a page, when the project is given as a path. */
function editUrl(g: GlobalArgs, doc: Doc): string | null {
  if (g.localPath || !g.host || !g.project || /^\d+$/.test(g.project)) {
    return null;
  }
  const dir = g.contentDir.replace(/^\/+|\/+$/g, "");
  return `https://${g.host}/${g.project}/-/edit/${g.ref}/${dir}/${doc.path}`;
}

/** Hugo/Docsy documentation search and context model. */
export const model = {
  type: "@cachehit/techdocs",
  version: "2026.10.23.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    index: {
      description:
        "Sync summary: source commit, counts, skipped files, page list",
      schema: IndexSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    corpus: {
      description:
        "Parsed pages and heading sections used by the other methods",
      schema: CorpusSchema,
      lifetime: "infinite" as const,
      garbageCollection: 2,
    },
    search: {
      description: "Latest search results, one hit per page",
      schema: SearchSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    doc: {
      description: "Latest page fetched with get_doc",
      schema: DocResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    context: {
      description:
        "Latest context bundle: cited Markdown sections for an AI agent",
      schema: ContextSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    sync: {
      description: "Download and index all content pages now",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, ctx: Ctx) => {
        const { handles } = await sync(ctx);
        return { dataHandles: handles };
      },
    },
    search: {
      description:
        "Ranked full-text search; returns the best-matching section of each page",
      arguments: z.object({
        query: z.string().min(1),
        limit: z.number().int().min(1).max(100).default(10),
        ...FilterArgs,
        refresh: RefreshSchema,
      }),
      execute: async (
        args: {
          query: string;
          limit: number;
          refresh: "auto" | "always" | "never";
        } & FilterInput,
        ctx: Ctx,
      ) => {
        const g = ctx.globalArgs;
        const { corpus, handles } = await ensureCorpus(ctx, args.refresh);
        const pages = bestPerDoc(
          searchChunks(corpus.docs, args.query, filtersOf(args)),
        );
        const hits = pages.slice(0, args.limit).map((
          { doc, chunk, score },
        ) => ({
          path: doc.path,
          title: doc.title,
          heading: chunk.heading,
          link: linkTo(g, doc, chunk.anchor),
          score: Math.round(score * 100) / 100,
          snippet: snippet(chunk.text || doc.description, args.query),
          taxonomies: doc.taxonomies,
        }));
        ctx.logger.info("Search {query}: {total} pages matched", {
          query: args.query,
          total: pages.length,
        });
        const handle = await ctx.writeResource("search", "search", {
          query: args.query,
          commit: corpus.commit,
          total: pages.length,
          hits,
        });
        return { dataHandles: [...handles, handle] };
      },
    },
    get_doc: {
      description:
        "Fetch one page by content path, site URL or alias, optionally one section",
      arguments: z.object({
        page: z.string().min(1).describe(
          "Content path (guides/setup.md), site URL or path (/guides/setup/), or alias",
        ),
        section: z.string().optional().describe(
          "H1/H2 heading text or anchor; defaults to the URL fragment, if any",
        ),
        refresh: RefreshSchema,
      }),
      execute: async (
        args: {
          page: string;
          section?: string;
          refresh: "auto" | "always" | "never";
        },
        ctx: Ctx,
      ) => {
        const g = ctx.globalArgs;
        const { corpus, handles } = await ensureCorpus(ctx, args.refresh);
        const doc = findDoc(corpus.docs, args.page, g);
        if (!doc) {
          const guesses = bestPerDoc(
            searchChunks(corpus.docs, args.page.replace(/[/._#-]+/g, " "), {}),
          ).slice(0, 5).map((m) => m.doc.path);
          throw new Error(
            `No page matches ${args.page}${
              guesses.length ? `; closest: ${guesses.join(", ")}` : ""
            }`,
          );
        }
        const wanted = (args.section ?? args.page.split("#")[1] ?? "").trim();
        let chunk: Chunk | undefined;
        if (wanted) {
          const key = wanted.toLowerCase();
          chunk = doc.chunks.find((c) =>
            c.anchor === key || c.heading.toLowerCase() === key
          );
          if (!chunk) {
            throw new Error(
              `No H1/H2 section ${wanted} in ${doc.path}; sections: ${
                doc.chunks.filter((c) => c.anchor).map((c) => c.heading).join(
                  ", ",
                )
              }`,
            );
          }
        }
        ctx.logger.info("Fetched {path}{section}", {
          path: doc.path,
          section: chunk ? `#${chunk.anchor}` : "",
        });
        const { chunks: _chunks, ...page } = doc;
        const handle = await ctx.writeResource("doc", "doc", {
          ...page,
          link: linkTo(g, doc, chunk?.anchor),
          editUrl: editUrl(g, doc),
          commit: corpus.commit,
          section: chunk?.heading ?? null,
          content: chunk ? chunk.text : doc.body,
          related: related(corpus.docs, doc, g),
        });
        return { dataHandles: [...handles, handle] };
      },
    },
    build_context: {
      description:
        "Bundle the best-matching sections, with citations, into Markdown within a token budget",
      arguments: z.object({
        query: z.string().min(1),
        maxTokens: z.number().int().min(500).max(200_000).default(8000),
        maxSections: z.number().int().min(1).max(100).default(12),
        ...FilterArgs,
        refresh: RefreshSchema,
      }),
      execute: async (
        args: {
          query: string;
          maxTokens: number;
          maxSections: number;
          refresh: "auto" | "always" | "never";
        } & FilterInput,
        ctx: Ctx,
      ) => {
        const g = ctx.globalArgs;
        const { corpus, handles } = await ensureCorpus(ctx, args.refresh);
        const matches = searchChunks(corpus.docs, args.query, filtersOf(args))
          .filter((m) => m.chunk.text);
        const bundle = buildContext(matches, args.query, {
          maxTokens: args.maxTokens,
          maxSections: args.maxSections,
          link: (doc, chunk) => linkTo(g, doc, chunk.anchor),
          commit: corpus.commit,
        });
        ctx.logger.info(
          "Context for {query}: {sections} sections, ~{tokens} tokens, truncated {truncated}",
          {
            query: args.query,
            sections: bundle.sources.length,
            tokens: bundle.estimatedTokens,
            truncated: bundle.truncated,
          },
        );
        const handle = await ctx.writeResource("context", "context", {
          query: args.query,
          commit: corpus.commit,
          ...bundle,
        });
        return { dataHandles: [...handles, handle] };
      },
    },
  },
};
