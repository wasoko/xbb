# Diff tab — discarded edits and history versions

A tab that diffs one row version against the text the row carries now, with one
Apply button per changed region. It backs the conflict flow in `docs/greet.md` §6:
a merge that discarded a local edit files it under `rec.cr`, and this tab is
how that text is offered back.

## 1. Where a version comes from

| source | key | written by |
|:--|:--|:--|
| `ver` | server `dt` (ISO) | `pullPush` on accept, `deepMerge` on adoption or union, `daEdit` on the base an edit is made from |
| `cr` | `devAgent` + local `modAt` (ISO) | `deepMerge` when the server copy wins |

Both hold `row` minus `rec`, so a version cannot nest history (`sdb.putVer` /
`putCr`). The `cr` key names the client that discarded the edit, so the log merges by key
and travels: the RPC payload carries it, `deepMerge` unions both sides, and `withCr`
carries it onto the row that replaces a local one in a snap merge or a PK relocation. A
row holding a `cr` entry carries `FIXMEchange_rejected` in `tags[]`, so the tag UI can
list it for cleanup. Snapshots drop `rec.ver` (`sdb.withoutVer`), never `cr`.

## 2. The tab

The tab ref is `diff|<source>|<stamp>|<row ref>`. `encodeTabs` URL-encodes it, so a
diff tab survives a reload and re-opening it focuses the same tab. `Artfact`
(`src/ui/editor.tsx`) parses it before the code editor branch and mounts
`src/ui/diffTab.tsx` in its place; a diff tab has no buffer, no metadata dropdown, and
is skipped by the contents and greet loops and by `saveToDb`.

Three ways in:

- the row's tab menu lists its `ver` and `cr` stamps, and picking one opens that diff;
- a fresh `cr` announces itself from the greet round (`greet.ts` conflict store) and the
  editor opens the diff for a ref it already has open, at most one per batch — a snap
  merge must not open a tab per row;
- the tab label reads `⇄ <source> <ago> <basename>`, and a row holding `cr` entries shows
  the count next to its own label (`tabState.conflicts`).

## 3. The diff

`src/ui/diff.ts` is pure:

- `diffHunks(local, server)` — one `diff-match-patch` pass, `diff_cleanupSemantic` so a
  reworded region reads as one hunk, then each run of edit ops with 40 characters of
  context on both sides. A hunk carries the `local` and `server` region strings, their
  offsets in the two texts, and an ANSI display string: `\x1b[31m` for the local-only
  text, `\x1b[32m` for the server-only text, `\x1b[0m` to reset.
- `applyHunk(txt, hunk)` — replaces that region of `txt` with the hunk's `local` text,
  checking the recorded offset first and falling back to a search; a region it cannot
  place reports `failed` instead of guessing.
- `parseAnsi(text)` — splits a display string into coloured runs and drops every other
  escape sequence, so row text cannot smuggle control codes into the view.

## 4. Apply

Applying writes the row through `daEdit` (text, `modAt`, plus the base shelf), drops the
`cr` entry it came from when the source is `cr` — with the last entry, the
`FIXMEchange_rejected` tag (`sdb.dropCrEntry`) — refreshes the editor buffer through
`onApplied`, and calls `softGreet()`. Applying from `ver` is an ordinary local edit. Hunks
are applied one at a time, so the view re-diffs after each write.

## 5. References

- `docs/greet.md` — the merge that writes `cr`, and the tab's other conflict surfaces
- `src/ui/diffTab.tsx`, `src/ui/diff.ts`, `src/ui/editor.tsx` — tab, pure diff, plumbing
- `test/diff.test.ts` — hunk splitting, ANSI runs, per-hunk apply
