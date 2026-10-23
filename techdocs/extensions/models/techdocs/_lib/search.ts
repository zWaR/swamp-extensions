/**
 * Ranked full-text search over page chunks and token-budgeted context bundles
 * for AI agents.
 *
 * @module
 */
// SPDX-License-Identifier: Apache-2.0

import MiniSearch from "npm:minisearch@7.2.0";
import type { Chunk, Doc } from "./content.ts";

/** Narrows which pages a search considers. */
export interface Filters {
  /** Keep pages whose content path starts with this prefix. */
  pathPrefix?: string;
  /** Keep pages whose content path contains this text, for example `/how-to/`. */
  pathContains?: string;
  /** Every listed taxonomy must contain at least one of the given terms. */
  taxonomies?: Record<string, string[]>;
}

/** A matching chunk with its page and BM25 score. */
export interface ChunkMatch {
  doc: Doc;
  chunk: Chunk;
  score: number;
}

/** Keeps only the pages that pass every filter. */
export function filterDocs(docs: Doc[], filters: Filters): Doc[] {
  const wanted = Object.entries(filters.taxonomies ?? {})
    .filter(([, terms]) => terms.length);
  return docs.filter((doc) =>
    (!filters.pathPrefix || doc.path.startsWith(filters.pathPrefix)) &&
    (!filters.pathContains || doc.path.includes(filters.pathContains)) &&
    wanted.every(([key, terms]) => {
      const have = (doc.taxonomies[key] ?? []).map((t) => t.toLowerCase());
      return terms.some((t) => have.includes(t.toLowerCase()));
    })
  );
}

/**
 * Ranks chunks of the filtered pages against `query`. Requires every term
 * first and falls back to any term when nothing matches all of them.
 */
export function searchChunks(
  docs: Doc[],
  query: string,
  filters: Filters,
): ChunkMatch[] {
  const pool = filterDocs(docs, filters).flatMap((doc) =>
    doc.chunks.map((chunk) => ({ doc, chunk }))
  );
  const index = new MiniSearch({
    fields: ["title", "heading", "description", "terms", "text"],
    extractField: (item: { id: number }, field: string) => {
      const { doc, chunk } = pool[item.id];
      switch (field) {
        case "id":
          return String(item.id);
        case "title":
          return doc.title;
        case "heading":
          return chunk.heading;
        case "description":
          return doc.description;
        case "terms":
          return Object.values(doc.taxonomies).flat().join(" ");
        default:
          return chunk.text;
      }
    },
    searchOptions: {
      boost: { title: 3, heading: 2, description: 2, terms: 2 },
      fuzzy: 0.2,
      prefix: true,
    },
  });
  index.addAll(pool.map((_, id) => ({ id })));
  let results = index.search(query, { combineWith: "AND" });
  if (!results.length) results = index.search(query, { combineWith: "OR" });
  return results.map((r) => ({ ...pool[Number(r.id)], score: r.score }));
}

/** Best-scoring chunk per page, in rank order. */
export function bestPerDoc(matches: ChunkMatch[]): ChunkMatch[] {
  const seen = new Set<string>();
  return matches.filter((m) => {
    if (seen.has(m.doc.path)) return false;
    seen.add(m.doc.path);
    return true;
  });
}

/** A short excerpt around the first query term found in `text`. */
export function snippet(text: string, query: string, length = 240): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const lower = flat.toLowerCase();
  const terms = query.toLowerCase().split(/\W+/).filter((t) => t.length > 1);
  const hit = terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0)
    .sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, hit - Math.floor(length / 3));
  const piece = flat.slice(start, start + length);
  return `${start ? "…" : ""}${piece}${
    start + length < flat.length ? "…" : ""
  }`;
}

/** Rough token estimate (4 characters per token) used for budgets. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** One section included in a context bundle. */
export interface ContextSource {
  title: string;
  heading: string;
  path: string;
  link: string;
  score: number;
}

/** A Markdown bundle of the best-matching sections within a token budget. */
export interface ContextBundle {
  markdown: string;
  sources: ContextSource[];
  estimatedTokens: number;
  /** True when matching sections were cut or left out to fit the budget. */
  truncated: boolean;
}

/** Packs the highest-ranked sections into Markdown until the budget is spent. */
export function buildContext(
  matches: ChunkMatch[],
  query: string,
  options: {
    maxTokens: number;
    maxSections: number;
    link: (doc: Doc, chunk: Chunk) => string;
    commit: string | null;
  },
): ContextBundle {
  const header = `# Documentation context: ${query}\n\n${
    options.commit ? `Source commit: ${options.commit}\n\n` : ""
  }`;
  const parts = [header];
  const sources: ContextSource[] = [];
  let used = estimateTokens(header);
  let truncated = false;
  for (const { doc, chunk, score } of matches) {
    if (sources.length >= options.maxSections) {
      truncated = true;
      break;
    }
    const link = options.link(doc, chunk);
    const title = chunk.anchor ? `${doc.title} › ${chunk.heading}` : doc.title;
    const head = `## ${title}\n\nSource: ${link}\n\n`;
    // Characters left for this section's text after its header and separator.
    const remaining = (options.maxTokens - used) * 4 - head.length - 2;
    // Below ~200 tokens a fragment is not worth its header.
    if (remaining < 800) {
      truncated = true;
      break;
    }
    let text = chunk.text;
    if (text.length > remaining) {
      text = `${text.slice(0, remaining - 1)}…`;
      truncated = true;
    }
    const part = `${head}${text}\n\n`;
    parts.push(part);
    used += estimateTokens(part);
    sources.push({
      title: doc.title,
      heading: chunk.heading,
      path: doc.path,
      link,
      score,
    });
  }
  return {
    markdown: parts.join("").trimEnd() + "\n",
    sources,
    estimatedTokens: used,
    truncated,
  };
}
