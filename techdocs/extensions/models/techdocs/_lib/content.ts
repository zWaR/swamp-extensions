/**
 * Turns Hugo content files into searchable documents: front matter, section
 * chunks split at H1/H2 headings, heading anchors and published URLs.
 *
 * @module
 */
// SPDX-License-Identifier: Apache-2.0

import { parse as parseYaml } from "jsr:@std/yaml@1.3.0";
import { parse as parseToml } from "jsr:@std/toml@1.0.11";

/** One heading-delimited section of a page. */
export interface Chunk {
  /** Heading text, or the page title for text before the first heading. */
  heading: string;
  /** Heading anchor without `#`; empty for the text before the first heading. */
  anchor: string;
  /** Section text with shortcode delimiters and HTML comments removed. */
  text: string;
}

/** A parsed content page. */
export interface Doc {
  /** Path relative to the content directory, POSIX separators. */
  path: string;
  /** Site-relative URL, for example `/guides/setup/`. */
  url: string;
  title: string;
  description: string;
  weight: number | null;
  aliases: string[];
  /** Configured taxonomy fields, each normalised to a string list. */
  taxonomies: Record<string, string[]>;
  /** Markdown body without the front matter block. */
  body: string;
  /** Every heading from H1 to H6, in page order. */
  headings: string[];
  chunks: Chunk[];
}

/** Options that change how pages map to URLs and taxonomies. */
export interface ParseOptions {
  /** Mirrors the Hugo `uglyURLs` setting. */
  uglyUrls: boolean;
  /** Front matter keys to read as taxonomies. */
  taxonomies: string[];
  /** Custom output format name (lowercase) to `baseName`, see {@link pageUrl}. */
  outputFormats?: Record<string, string>;
}

/** Result of parsing one file: a page, or the reason it was left out. */
export type ParseResult =
  | { doc: Doc }
  | { skipped: string };

/** Splits a raw file into its front matter object and body. */
export function splitFrontMatter(
  raw: string,
): { data: Record<string, unknown>; body: string } {
  const text = raw.replace(/^\uFEFF/, "");
  const delimiter = text.startsWith("---")
    ? "---"
    : text.startsWith("+++")
    ? "+++"
    : null;
  if (!delimiter) return { data: {}, body: text };
  const lines = text.split(/\r?\n/);
  if (lines[0].trim() !== delimiter) return { data: {}, body: text };
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === delimiter);
  if (end < 0) throw new Error(`unterminated ${delimiter} front matter`);
  const source = lines.slice(1, end).join("\n");
  const parsed = delimiter === "---" ? parseYaml(source) : parseToml(source);
  const data = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
  return { data, body: lines.slice(end + 1).join("\n") };
}

/** Removes inline Markdown so heading text matches what readers see. */
function plainInline(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*~]/g, "")
    // Underscores are emphasis only at word edges; snake_case keeps them.
    .replace(/(^|[^\p{L}\p{N}])_+|_+(?=$|[^\p{L}\p{N}])/gu, "$1")
    .trim();
}

/** Hugo's default (GitHub-style) heading ID. */
export function anchorize(heading: string): string {
  return plainInline(heading)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .trim()
    .replace(/\s/g, "-");
}

/** Strips shortcode delimiters (keeping inner text) and HTML comments. */
export function cleanText(markdown: string): string {
  return markdown
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\{\{[<%][\s\S]*?[%>]\}\}/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Splits a body into chunks at H1/H2 headings outside code fences. */
export function chunkBody(
  body: string,
  title: string,
): { chunks: Chunk[]; headings: string[] } {
  const chunks: Chunk[] = [];
  const headings: string[] = [];
  const used = new Map<string, number>();
  let fence: string | null = null;
  let current = { heading: title, anchor: "", lines: [] as string[] };
  const flush = () => {
    const text = cleanText(current.lines.join("\n"));
    if (text || current.anchor) {
      chunks.push({ heading: current.heading, anchor: current.anchor, text });
    }
  };
  for (const line of body.split(/\r?\n/)) {
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
    }
    const heading = fence === null && !fenceMatch
      ? line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/)
      : null;
    if (!heading) {
      current.lines.push(line);
      continue;
    }
    const custom = heading[2].match(/^(.*?)\s*\{#([^}]+)\}$/);
    const text = plainInline(custom ? custom[1] : heading[2]);
    headings.push(text);
    if (heading[1].length > 2) {
      current.lines.push(line);
      continue;
    }
    flush();
    // Hugo suffixes repeated heading IDs with -1, -2, ...
    const base = custom ? custom[2] : anchorize(text);
    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    current = {
      heading: text,
      anchor: seen ? `${base}-${seen}` : base,
      lines: [],
    };
  }
  flush();
  return { chunks, headings };
}

/**
 * Hugo's path sanitising for one segment: lowercase, whitespace to hyphens,
 * and only letters, digits, marks and `._-+~#%` kept.
 */
function urlize(segment: string): string {
  return segment.trim().toLowerCase().replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}\p{M}._\-+~#%]/gu, "");
}

/**
 * Site-relative URL Hugo publishes for a content file. `outputFormats` maps a
 * custom output format name (lowercase) to its `baseName`, for list pages
 * whose front matter `outputs` starts with that format.
 *
 * shortcut: ignores `permalinks` config and multilingual prefixes; set front
 * matter `url` for pages those affect, or extend this when a site needs them.
 */
export function pageUrl(
  path: string,
  frontMatter: Record<string, unknown>,
  uglyUrls: boolean,
  outputFormats: Record<string, string> = {},
): string {
  if (typeof frontMatter.url === "string" && frontMatter.url.trim()) {
    const url = frontMatter.url.trim();
    return url.startsWith("/") ? url : `/${url}`;
  }
  const parts = path.split("/");
  const base = parts.pop()!.replace(/\.(md|markdown)$/i, "");
  const isList = base === "_index";
  const segments = base === "_index" || base === "index"
    ? parts
    : [...parts, base];
  if (
    !isList && segments.length && typeof frontMatter.slug === "string" &&
    frontMatter.slug.trim()
  ) {
    segments[segments.length - 1] = frontMatter.slug;
  }
  const joined = segments.map(urlize).join("/");
  const outputs = toList(frontMatter.outputs).map((o) => o.toLowerCase());
  const baseName = isList && outputs.length ? outputFormats[outputs[0]] : null;
  if (baseName) return `/${joined ? `${joined}/` : ""}${baseName}.html`;
  if (!joined) return uglyUrls ? "/index.html" : "/";
  if (!uglyUrls) return `/${joined}/`;
  return isList ? `/${joined}/index.html` : `/${joined}.html`;
}

/** Normalises a taxonomy value (string or list) to a string list. */
function toList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === "string" && value) return [value];
  return [];
}

/** Parses one content file; drafts and `exclude_search` pages are skipped. */
export function parseDoc(
  path: string,
  raw: string,
  options: ParseOptions,
): ParseResult {
  let parsed;
  try {
    parsed = splitFrontMatter(raw);
  } catch (error) {
    return { skipped: `front matter: ${(error as Error).message}` };
  }
  const { data, body } = parsed;
  if (data.draft === true) return { skipped: "draft" };
  if (data.exclude_search === true) return { skipped: "exclude_search" };
  const build = (data.build ?? data._build) as Record<string, unknown> | null;
  if (build && build.render === "never") return { skipped: "not rendered" };
  const fallback = path.split("/").filter((p) => !/^_?index\.md$/.test(p))
    .pop()?.replace(/\.(md|markdown)$/i, "") ?? path;
  const title = typeof data.title === "string" && data.title
    ? data.title
    : fallback;
  const { chunks, headings } = chunkBody(body, title);
  const taxonomies: Record<string, string[]> = {};
  for (const key of options.taxonomies) {
    const values = toList(data[key]);
    if (values.length) taxonomies[key] = values;
  }
  return {
    doc: {
      path,
      url: pageUrl(path, data, options.uglyUrls, options.outputFormats),
      title,
      description: typeof data.description === "string" ? data.description : "",
      weight: typeof data.weight === "number" ? data.weight : null,
      aliases: toList(data.aliases),
      taxonomies,
      body: body.trim(),
      headings,
      chunks,
    },
  };
}
