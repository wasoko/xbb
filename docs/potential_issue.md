# Outstanding potential issues — sea wall changes

State: `test/startagfeed` passes (406 passed, 1 skipped) and `pnpm build` passes. No commit was made. This file lists risks that are not covered by those checks or that still need a product decision.

## High priority

1. **No live render verification**
   - Chrome CDP was up, but the open browser profile had no `star.tagger.md` seed data, so the new shaders were not exercised against a real wall.
   - `pnpm build`/`tsc` do not compile GLSL. Runtime shader errors are still possible in:
     - `LABEL_VERTEX` (`uSpacing.x/y` scaling)
     - `POINT_VERTEX`/`POINT_FRAGMENT` (`aRecency`, `vDim`)
     - `STAR_VERTEX`/`STAR_FRAGMENT` (`uPxMin`, `uLift`, `uRecency`)
     - the sky shader (`uStarLift`)
   - Load the sea with real `db.das` rows and confirm labels, star glow, and recency dimming on screen.

2. **Taxonomy does not carry the full 1-hop graph**
   - `starTaggerTrace.ts` writes only the top 40 `### Web` edges (`topEdges(..., 40)` / `edges.slice(0, 40)`).
   - On a cold open, `graphFromTags` can therefore draw only a partial recent 2nd-level treemap.
   - The full children appear after `loadPinGraph` seeds. If the right band must be complete before seeding, add a compact `### Emerging` section with top tags and their children, or raise the web budget. Raising it increases the persisted table size.

3. **Recency semantics still have unresolved edges**
   - `recentStamp` uses `rowStamp` (which includes `rec.visitTime`, the historical typo, and `access2discard`) and falls back to `daStamp`; the seed's `base` scan is still newest `tid`, not newest `dt`.
   - An undated row falls back to `tid`, so it is not treated as “no stamp”.
   - The sea-level star takes the newest stamp of every `SeaRow` for `wall.star.pin`, including the pin card itself (`type: 'md'`). If “no dim if not a row” means link/evidence rows only, exclude `md` rows from `starStamp`.
   - Wall recency is normalized against the oldest/newest points on the whole wall, not against an absolute age horizon. A large old tail can make the front field dim more than expected.

4. **Trend thresholds are untuned**
   - Defaults are `recent: 500`, `minRecent: 3`, `minLift: 2`. They were chosen as starting points, not measured against a live table.
   - `recent` is clamped to `base`. Setting `recent` equal to `base` leaves an empty tail and gives every tag with enough recent support an unbounded lift; this should be validated or documented as a deliberate mode.
   - The recent band caps at `EMERGING_COLUMNS = 8` and children at `EMERGING_CHILDREN = 8`; these are layout constants, not Setup keys.

5. **Full suite is not green**
   - Unrelated failures observed:
     - `test/sync.test.ts`: missing `../src/sync`
     - `test/srctag-cdp.test.ts`: CDP/global boot timeouts; the sweep also regenerates `test-artifacts/srctag-sweep.*`
     - `test/md-text.test.tsx`: table rendering expectation
     - `test/greet.test.ts`: `beforeAll` timeout
     - `test/tip.test.ts`: missing IndexedDB API unhandled rejection
   - Focused tests and the build pass; the repository-wide signal remains noisy.

## Medium priority

6. **Pinned 2nd-level mapping**
   - Only the direct next heading level is used. Deeper levels are ignored.
   - A heading that names multiple tags puts children below the whole column and uses the first tag as `parent`.
   - A child repeated across cards is kept only for the first column; later occurrences are dropped.
   - Confirm this is the intended tree rather than a full heading hierarchy.

7. **Recent top-level semantics**
   - Top-level recent tags are tags kept by recent rows (0-hop); their 2nd level is `graph.edges` (1-hop).
   - If “top related tag” meant 1-hop neighbours as the top level, the ranking needs to change.

8. **Star hover/touch behavior**
   - The sea-level star opens on hover only when the hovered point/region belongs to `wall.star.pin`; touch opens it anywhere on the wall.
   - Normal size is `STAR_MIN_PX = 18`, full glow is `STAR_GLOW_PX = 168`.
   - Row stars still use their normal 11/5 px base sizes; only the pointer lift was removed. If “normally shrink to minimal” was meant for every star, point base sizes still need a pass.

9. **Label legibility at compressed spacing**
   - `LABEL_VERTEX` now multiplies region dimensions by `uSpacing.x/y`, so labels shrink with the wall.
   - There is no minimum rendered font size. At `SPACING_MIN` a name can become unreadable rather than hiding.
   - Decide whether a floor or a “hide below N px” rule is wanted.

10. **Rear tail discoverability**
    - Remaining clouds live at `lon 90..270` minus the two front bands, so they are hidden at reset.
    - Reveal requires a horizontal wheel, Ctrl/⌘+Shift+wheel, or horizontal pinch. There is no visible control or hint.
    - Both front bands can consume up to 120° each, leaving as little as 120° of tail; confirm that is enough on narrow viewports.

11. **Left/right is screen-relative**
    - Recent is `lon >= 0` and pinned is `lon <= 0`; this reads as recent-left/pinned-right only because the reset camera looks at `+z` with Y rotation `π`.
    - Any future change to the camera yaw convention or reset pose will visually invert the sides without changing the data.

12. **Pointer-leave behavior changed**
    - `onPointerLeave` now clears only `setPointer(-1, -1)` and `setStarHover(false)`; it intentionally leaves the hover card open so its buttons remain clickable.
    - If the card is supposed to disappear when the pointer leaves the canvas, this needs a different close rule.

## Housekeeping

13. **Alternate sea packing and docs**
    - `SeaRegions.tsx` / `seaRegion.ts` are not routed; `docs/startag/ui.md` still carries their packing details as an “alternate” section.
    - `wheelZoom` remains exported and tested but is no longer called by `SeaView`; the docs now describe Ctrl/⌘ as spacing, not FOV.
    - Retire or clearly label these paths before they drift further.

14. **Test artifacts and staged changes**
    - A full-suite run modified `test-artifacts/srctag-sweep.md` and `.svg`. Review or discard before committing.
    - The working tree contains staged changes unrelated to this work (`package.json`, `pnpm-lock.yaml`, `src/ui/editor.tsx`, `src/ui/restGrouper.ts`, plus pre-existing `seaRender`/`SeaView`/`seaWall` edits). Separate them before the next commit.
    - No commit has been made for the sea changes.
