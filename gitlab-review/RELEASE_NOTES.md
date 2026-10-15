## 2026.10.15.1

**Added:** `post_discussion` opens a general resolvable discussion thread on an MR, not tied to a file or line. `post_review` posts a note that can't be resolved, and `post_line_comment` needs a diff position, so feedback about files outside the diff or about the MR as a whole had no resolvable form. Re-posting the same body is skipped. A new `discussionThread` resource records each posted thread.

**Upgrade note:** Additive. No changes to existing methods or resource schemas.

## 2026.10.14.1

**Added:** The manifest now declares `license: Apache-2.0` (SPDX). The registry quality rubric scores a declared license separately from the bundled `LICENSE.md`.

**Upgrade note:** Metadata only. No code, schema, or behavioral changes.

## 2026.09.18.1

**Upgrade note:** Normalized `npm:zod` dependency version to 4.6.5 across the
repo. No behavioral changes in this extension.
