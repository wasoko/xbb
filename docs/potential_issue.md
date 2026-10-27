# Outstanding potential issues — sea wall changes

State: `test/startagfeed` passes (434 passed, 1 skipped) and `pnpm build` passes. No commit was made. The tagger's and the sea's own issues now live in
[2mod/tagger.md](2mod/tagger.md#issues); this file keeps the repository-state items.

## High priority

1. **No live render verification**
   - Chrome CDP was up, but the open browser profile had no `star.tagger.md` seed data, so the new shaders were not exercised against a real wall.
   - `pnpm build`/`tsc` do not compile GLSL. Runtime shader errors are still possible in:
     - `LABEL_VERTEX` (`uSpacing.x/y` scaling)
     - `POINT_VERTEX`/`POINT_FRAGMENT` (`aRecency`, `vDim`, `uResolution`, `uPointer`)
     - `STAR_VERTEX`/`STAR_FRAGMENT` (`uPxX`, `uPxY`, `uCorePx`, `uRecency`)
     - the sky shader (`RING_DEPTH_PX` and the one-pixel ring line)
   - Load the sea with real `db.das` rows and confirm labels, star glow, and recency dimming on screen.

2. **Full suite is not green**
   - Unrelated failures observed:
     - `test/sync.test.ts`: missing `../src/sync`
     - `test/srctag-cdp.test.ts`: CDP/global boot timeouts; the sweep also regenerates `test-artifacts/srctag-sweep.*`
     - `test/md-text.test.tsx`: table rendering expectation
     - `test/greet.test.ts`: `beforeAll` timeout
     - `test/tip.test.ts`: missing IndexedDB API unhandled rejection
   - The focused tests and the build pass; the repository-wide signal remains noisy.

## Housekeeping

3. **Test artifacts and staged changes**
   - A full-suite run modified `test-artifacts/srctag-sweep.md` and `.svg`. Review or discard before committing.
   - The working tree contains staged changes unrelated to this work (`package.json`, `pnpm-lock.yaml`, `src/ui/editor.tsx`, `src/ui/restGrouper.ts`, plus pre-existing `seaRender`/`SeaView`/`seaWall` edits). Separate them before the next commit.
   - No commit has been made for the sea changes.
