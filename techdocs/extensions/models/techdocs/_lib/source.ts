/**
 * Reads Markdown content files from a GitLab repository archive or a local
 * checkout.
 *
 * @module
 */
// SPDX-License-Identifier: Apache-2.0

import { UntarStream } from "jsr:@std/tar@0.1.10/untar-stream";

/** One Markdown file, path relative to the content directory. */
export interface SourceFile {
  path: string;
  content: string;
}

/** Every content file at one point in time. */
export interface Snapshot {
  /** Commit SHA the files came from; null for a local directory. */
  commit: string | null;
  files: SourceFile[];
}

/** Where to read content from in GitLab. */
export interface GitLabSource {
  /** Host name without scheme, for example `gitlab.example.com`. */
  host: string;
  /** Project path (`group/project`) or numeric ID. */
  project: string;
  ref: string;
  token: string;
  contentDir: string;
}

const MARKDOWN = /\.(md|markdown)$/i;
const TIMEOUT_MS = 120_000;

/** Calls the GitLab REST API; errors name the request, never the token. */
async function gitlab(source: GitLabSource, path: string): Promise<Response> {
  const url = `https://${source.host}/api/v4/projects/${
    encodeURIComponent(source.project)
  }${path}`;
  const response = await fetch(url, {
    headers: { "PRIVATE-TOKEN": source.token },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) {
    await response.body?.cancel();
    const hint = response.status === 401
      ? " (token rejected: store a fresh one with `swamp vault put`)"
      : response.status === 404
      ? " (check project, ref and that the token can read the repository)"
      : "";
    throw new Error(
      `GitLab returned ${response.status} for ${path.split("?")[0]}${hint}`,
    );
  }
  return response;
}

/** Commit SHA that `ref` currently points to. */
export async function gitlabHead(source: GitLabSource): Promise<string> {
  const response = await gitlab(
    source,
    `/repository/commits/${encodeURIComponent(source.ref)}`,
  );
  const { id } = await response.json() as { id?: string };
  if (!id) throw new Error(`GitLab returned no commit for ref ${source.ref}`);
  return id;
}

/** Downloads the content directory at the current head of `ref`. */
export async function gitlabSnapshot(source: GitLabSource): Promise<Snapshot> {
  const commit = await gitlabHead(source);
  const response = await gitlab(
    source,
    `/repository/archive.tar.gz?sha=${commit}&path=${
      encodeURIComponent(source.contentDir)
    }`,
  );
  const prefix = `${source.contentDir.replace(/^\/+|\/+$/g, "")}/`;
  const files: SourceFile[] = [];
  if (!response.body) {
    throw new Error(
      `GitLab returned an empty archive for ${source.contentDir}`,
    );
  }
  const entries = response.body
    .pipeThrough(new DecompressionStream("gzip"))
    .pipeThrough(new UntarStream());
  for await (const entry of entries) {
    // Archive entries are `<archive-root>/<contentDir>/...`.
    const path = entry.path.split("/").slice(1).join("/");
    if (!entry.readable) continue;
    if (!path.startsWith(prefix) || !MARKDOWN.test(path)) {
      await entry.readable.cancel();
      continue;
    }
    files.push({
      path: path.slice(prefix.length),
      content: await new Response(entry.readable).text(),
    });
  }
  return { commit, files };
}

/** Reads every Markdown file under `<root>/<contentDir>`. */
export async function localSnapshot(
  root: string,
  contentDir: string,
): Promise<Snapshot> {
  const base = `${root.replace(/\/+$/, "")}/${contentDir.replace(/^\/+/, "")}`;
  const files: SourceFile[] = [];
  const walk = async (relative: string): Promise<void> => {
    for await (const entry of Deno.readDir(`${base}/${relative}`)) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory) await walk(path);
      else if (entry.isFile && MARKDOWN.test(entry.name)) {
        files.push({
          path,
          content: await Deno.readTextFile(`${base}/${path}`),
        });
      }
    }
  };
  await walk("");
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { commit: null, files };
}
