# Diff tab — discarded edits and history versions

A tab that diffs one row version against the text the row carries now, with one
Apply button per change. It backs the conflict flow in `docs/greet.md` §6:
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

Each menu row also carries its `+add/-del` line delta against the text the row carries now
(`diffStat`, computed after the menu has painted) and a `del` button that trashes that entry
(`sdb.dropHistEntry`).

## 3. The diff

`src/ui/diff.ts` is pure:

- `diffHunks(local, server)` — one `diff-match-patch` pass, `diff_cleanupSemantic` so a
  reworded region reads as one hunk, then each run of edit ops with 40 characters of
  context on both sides. A hunk carries the `local` and `server` region strings, their
  offsets in the two texts, and an ANSI display string: `\x1b[31m` for the local-only
  text, `\x1b[32m` for the server-only text, `\x1b[0m` to reset.
- `DiffHunk.changes` — the same region split into changes: a delete block plus the insert
  block that replaces it, and a further delete after an insert opens the next change. The
  tab shows one row and one Apply button per change, so a region holding several changes is
  taken one at a time; a region holding one (the norm) keeps the hunk's own button.
- `diffStat(version, row)` — line counts of the same pass: lines only the version has
  (`add`) and lines only the row has (`del`), for the menu row.
- `applyHunk(txt, hunk)` — replaces that region of `txt` with the hunk's `local` text,
  checking the recorded offset first and falling back to a search; a region it cannot
  place reports `failed` instead of guessing. It takes a hunk or one of its changes.
- `parseAnsi(text)` — splits a display string into coloured runs and drops every other
  escape sequence, so row text cannot smuggle control codes into the view.

## 4. Apply and discard

Applying writes the row through `daEdit` (text, `modAt`, plus the base shelf) and refreshes
the editor buffer through `onApplied`. The `cr` entry stays, so the changes not yet taken can
still be taken: the tab re-diffs against the text the row carries after each write. Once
nothing is left to apply — every change applied, or the row already carrying the entry's text
— the tab offers `Discard this cr`, which trashes the entry without writing text.
Discarding (`sdb.dropHistEntry`) drops the `cr` key and, with the last one, the
`FIXMEchange_rejected` tag, then marks the row dirty so the reduced log is pushed: the log
travels in the RPC payload, and a clean row would take the entry back from the server copy.
Applying from `ver` is an ordinary local edit. A `ver` entry is local bookkeeping, so
trashing one drops it without a push.

## 5. References

- `docs/greet.md` — the merge that writes `cr`, and the tab's other conflict surfaces
- `src/ui/diffTab.tsx`, `src/ui/diff.ts`, `src/ui/editor.tsx` — tab, pure diff, plumbing
- `test/diff.test.ts` — hunk and change splitting, ANSI runs, line deltas, apply
- `test/ver.test.ts` — `ver`/`cr` helpers, including `dropHistEntry`
