# @cachehit/techdocs

Search and AI context building for a [Hugo](https://gohugo.io/) documentation site, such as one built with
[Docsy](https://www.docsy.dev/). The model reads the Markdown source from GitLab or a local checkout, not the
published site, so it also works when the site is behind single sign-on or a VPN.

## Prerequisites

- [swamp](https://github.com/swamp-club/swamp) CLI
- For GitLab: a token that can read the repository (`read_repository` or `read_api` scope)

## Installation

```bash
swamp extension pull @cachehit/techdocs
```

## Usage

### Store the token

Store the GitLab token in a swamp vault and reference it with a `vault.get` expression. Any vault type works.

```bash
swamp vault create local_encryption docs   # once, if you have no vault yet
swamp vault put docs GITLAB_TOKEN          # prompts; the value never touches shell history
```

### Create a model instance

```bash
swamp model create @cachehit/techdocs docs \
  --global-arg siteUrl=https://docs.example.com \
  --global-arg host=gitlab.example.com \
  --global-arg project=group/docs \
  --global-arg ref=main \
  --global-arg 'token=${{ vault.get("docs", "GITLAB_TOKEN") }}'
```

To index a local checkout instead, for example to search pages that aren't merged yet, set `localPath` and leave out
`host`, `project` and `token`:

```bash
swamp model create @cachehit/techdocs docs-local \
  --global-arg siteUrl=https://docs.example.com \
  --global-arg localPath=/path/to/docs-repo
```

Global arguments:

| Argument        | Default                  | Purpose                                                                    |
| --------------- | ------------------------ | -------------------------------------------------------------------------- |
| `siteUrl`       | (required)               | Published site root, used to build links                                   |
| `host`          | (none)                   | GitLab host name without scheme                                            |
| `project`       | (none)                   | GitLab project path (`group/project`) or numeric ID                        |
| `ref`           | `main`                   | Branch, tag or commit to read                                              |
| `token`         | (none)                   | GitLab token, as a `vault.get` expression                                  |
| `localPath`     | (none)                   | Local repository root; replaces the GitLab settings                        |
| `contentDir`    | `content`                | Hugo content directory, relative to the repository root                    |
| `uglyUrls`      | `false`                  | Match the site's Hugo `uglyURLs` setting                                   |
| `taxonomies`    | `["categories", "tags"]` | Front matter keys to index and filter on                                   |
| `outputFormats` | `{}`                     | Custom output format name to `baseName`, for pages such as reveal.js decks |

### Search

```bash
swamp model method run docs search --input query="rollback a deployment"
swamp model method run docs search --input query=kubernetes --input pathContains=/how-to/
swamp model method run docs search --input query=alerts --input 'taxonomyTerms:json={"tags":["monitoring"]}'
```

Each hit gives the page title, the best-matching heading, a deep link (`…/page/#heading`) and a snippet. Ranking
weighs the title, heading and description above body text. The search tolerates typos and matches word prefixes. It
looks for pages containing every query term first, then falls back to pages containing any of them.

### Read a page

```bash
swamp model method run docs get_doc --input page=https://docs.example.com/guides/deploy/#rollback
swamp model method run docs get_doc --input page=guides/deploy.md --input section=Rollback
```

`page` accepts a content path, a site URL or path, or a front matter alias. A URL fragment, or the `section` input
(an H1/H2 heading or its anchor), returns just that section. Deeper headings stay inside their H2 section. The result
includes the GitLab edit URL and up to five related pages that share taxonomy
terms.

### Build context for an AI agent

```bash
swamp model method run docs build_context --input query="on-call handover" --input maxTokens=6000
swamp data get docs context --json | jq -r .attributes.markdown
```

The bundle is Markdown made of the highest-ranked sections. Each section is preceded by its source link, and the
header records the source commit. The bundle stops when it reaches `maxTokens` (estimated at 4 characters per token) or
`maxSections`, and `truncated` says whether anything was cut. In workflows, reference it with
`data.latest("docs", "context").attributes.markdown`.

### Freshness

`search`, `get_doc` and `build_context` accept `refresh`:

- `auto` (default): one API call checks the branch head and re-syncs only if it moved. A local checkout is re-read
  every time.
- `always`: re-sync first.
- `never`: use the stored data without any network call.

The corpus is also rebuilt when settings that change parsing (`contentDir`, `uglyUrls`, `taxonomies`, `outputFormats`,
source) differ from those it was built with.

## Data

| Resource  | Content                                                                       |
| --------- | ----------------------------------------------------------------------------- |
| `index`   | Source commit, page and section counts, skipped files with reasons, page list |
| `corpus`  | Parsed pages and sections, used by the other methods                          |
| `search`  | Latest search results                                                         |
| `doc`     | Latest page from `get_doc`                                                    |
| `context` | Latest context bundle with its sources                                        |

The corpus holds the full text of the site. It's stored in the swamp repository's datastore, so treat that datastore
with the same care as a clone of the documentation repository.

## Limitations

- Hugo `permalinks` configuration and multilingual URL prefixes aren't applied. Pages they affect need a front matter
  `url`.
- Only Markdown (`.md`, `.markdown`) content is indexed. HTML content files are skipped.
- Shortcode delimiters are removed and their inner text kept. Content that a shortcode generates at build time isn't
  included.
- Headings are anchored with Hugo's default GitHub-style IDs.

## License

Apache-2.0. See [LICENSE.md](LICENSE.md).
