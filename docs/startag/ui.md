# The tag layer's readings and chrome (ui)

`docs/startag/` is three documents over one feature. [sTag.md](sTag.md) owns the evidence a
tag comes from, [rstag.md](rstag.md) owns the engine that scores it, and this file owns what
a pass's reports are *drawn as* and what a reader drives them from. The split is by what each
side can know: nothing here scores a row, and nothing there draws one.

A reading is one way of filing the same `Map<tid, RowTagReport>`. The rest list's own
readings — the chips, the tuner strip, the panel a reading is chosen in — are
[sTag.md](sTag.md#the-visualization-panel-srcuirestviztsx)'s. This file owns the three that
draw the tags themselves as one object, and the two places outside the list where a reader
tags rows (the omnibox and the settings rows).

| Reading | Drawn as | Answers |
|---|---|---|
| **star** (the sea, `#/`) | the table as a wall of regions, with a mark per region | where a tag is, at a glance, over a whole window |
| **pin** (`pinReach`) | the bands the star and the disc both read | how far a tag is from the curated half |
| **graph** (`rgraph=1`) | a radial disc in a window of its own | how tags sit next to each other |

## Where it sits

```
src/ui/seaPinGraph.ts   loadPinGraph: pins + up to `base` tab/tag rows, scored with qarf
        │  PinGraphSeed { pins, rows, reports, graph, reach, recency }
        ▼
src/ui/restGraph.ts     buildTagGraph · pinReach · tagGraphLayout   (tags, not pixels)
        │
        ├──▶ src/ui/seaRegion.ts    the packing: seaRegions · regionTiers
        │            │
        │            ▼
        │    src/ui/seaStars.ts     one mark per region, and the edges among them
        │            │
        │            ▼
        │    src/ui/seaSky.ts · seaScene.ts · seaMotion.ts · SeaRegions.tsx · SeaView.tsx
        │              the wall, its geometry, its glide, its boxes, its camera and input
        │
        └──▶ src/ui/TagGraph.tsx    the disc, over the same graph
                     ▲
             src/ui/restGraphWindow.ts   the rgraph flag, and the wide window
```

| Module | Knows | Does not know |
|---|---|---|
| `src/ui/restGraph.ts` | tags, rows, reports, pins: `buildTagGraph`, `pinReach`, `tagGraphLayout` | the DOM, React, a pass |
| `src/ui/seaSky.ts` | the one place↔direction convention of the wall | tags, three, the DOM |
| `src/ui/seaRegion.ts` | the packing and the tier of every region | three, the DOM, React |
| `src/ui/seaStars.ts` | the marks and the edges over a packing | where they are on screen |
| `src/ui/seaScene.ts` | the three geometry: grid band, cell patch, edges, points | tags as words |
| `src/ui/seaMotion.ts` | the glide, the wheel and the stored strength | the scene |
| `src/ui/seaPinGraph.ts` | which rows the sea reads, and how new each tag's evidence is | the wall |
| `src/ui/SeaView.tsx` | the camera, the input, the readout, the route's pointer rule | what a region is |
| `src/ui/SeaRegions.tsx` | what a box *is*; the frame loop owns where it is | the packing |
| `src/ui/restCue.ts` | the two colour rules a tag or a share is drawn with | any reading |
| `src/ui/tap.tsx` | the bar, its panels, the omnibox box, the settings rows | a reading |

The dependency runs one way: the UI imports the engine, and no engine module imports the
DOM. `restCue.ts` exists because a `color-mix()` string means nothing to WebGL: each rule is
given twice, as the CSS string a panel takes and as the channels a canvas takes, so the
chips beside a row, a cluster head, the disc and the wall read the same table the same way.

## Star (sea)

The sea is the table wrapped on a cylinder: a camera on the axis, a grid for its wall, and the
tags a pass kept hung on it. It is a background rather than a page — a fixed
canvas behind `.content`, which is translucent above it — and only `/` hands it the pointer,
so a click reaches the wall exactly when nothing is drawn over it. The readouts follow the
same rule: they are the sky's own chrome, hung below the user bar rather than under it.

### The wall

`seaSky.ts` owns one convention and nothing else: a place is `SeaPlace { lon, rise }`, a
longitude that wraps at 360 and a height that runs without end. `seaVec` places a point,
`vecSea` reads a direction back to the wall (and returns nothing for a direction along the
axis), and one degree of rise is the same distance at every longitude — so a grid cell is a
square of wall, `gridSpacing` drives both axes from `[1, 2, 5, 10, 15, 30, 45, 60, 90]`, and
a cell tiles the wall with no exception at either end.

A *cylinder* rather than a sphere is what makes the vertical axis a pan: the sphere this
replaced turned its bands over a pole, where they bunched. `visibleRise` is how much of the
wall a field of view covers, which is why the sea opens at 120 degrees and stops at 140 —
near 180 the frustum spans hundreds of grid steps, a grid finer than a screen can show.

### The seed

`seaPinGraph.loadPinGraph(setup)` reads the pin cards plus up to `base` (5000 by default)
`type='tab'` and `type='tag'` rows, because a hop is a statement about the whole window
rather than about the rows a reader happens to have scrolled to. It scores them with the
`qarf` profile and returns `PinGraphSeed`: the pins, the rows, one report per scored row, the
graph over them with a pin's variant spellings kept apart, each node's reach and each tag's
`recency` (where the newest row that kept it sits in the window). The overrides and the
generated taxonomy live in `star.tagger.md`; see
[row=star.tagger.md](row=star.tagger.md).

The row is read with `useLiveQuery`, so editing its `## Setup` re-seeds the sea and writing
the generated `## Taxonomy` does not. Its reports become `restTagStore`'s first pass so the
omnibox's suggestion zone has hints before the rest list has ever run; the list's own pass
then publishes over it. A seed that never lands writes the reason into the readout's legend
instead of the bands, so an empty sky reads as an unread table.

### The packing

`seaRegions(graph, { recency, kind, …shape })` reads the graph in `pinReach` by default and
returns one `SeaRegion` — `{ tag, kind, rows, lon0, lon1, rise0, rise1, cluster? }` — per tag
it kept: every root, then the widest others up to `maxRegions` (220). The wall has three
parts, and the reason for each is what it is read for:

- **the column** is the curated half — the one part a reader scans in time order. The pins
  stand in a 96 degree column down the middle, newest `recency` first, each band as tall as
  its own rows ask for (clamped to `minH` 14 … `maxH` 60). A pin's spellings take a 14 degree
  band along the bottom of that pin's own band, split evenly rather than by rows, because a
  spelling's own row count would divide the band into slivers.
- **the strips** hold everything else. Each tag answers for the pin within two hops of it
  (`clusterOf`, the `pinReach` resolver), a cluster's whole run goes to one strip, and the
  runs alternate west and east in the column's own order, so a pin's neighbourhood reads as
  one shelf. Each strip is 132 degrees (west from −180, east from +48) and a tag no pin
  reaches is the east strip's tail — the end of the reading is where a reader looks last.
- **a shelf** takes tags until the next one would not fit, then stretches up to
  `maxStretch` (1.8) so its regions close the strip between them. A region's wall is
  `areaPerRow` (6) × its rows, its width `clamp(sqrt(area × aspect), minW, strip)`, and it
  hangs from the shelf's top edge at the height its own area then needs — so the stretch that
  widens a region narrows it by exactly as much and area keeps following rows. The shelf
  clears the tallest region on it, which is what leaves wall below a shorter one.

`regionAt` and `regionsInCell` are the two reads of that packing: what a pointer is over,
and what a grid cell holds.

### The tiers

What a region shows is decided by the screen, not by the table. The frame loop measures each
region's projected box and publishes the tier it earned; React draws it, and `SeaRegions.tsx`
mounts one box per visible region. The screen is spent widest box first, because a region a
reader can see is worth more than one they cannot:

| Tier | Shows | Earned by |
|---|---|---|
| `blocks` | the tag's name and up to `BLOCK_ROWS` (12) of its rows | `SEA_LIMITS.blockPx` (14000) of box and one of the 8 row budgets — or a curated tag, which is never the one that gives way |
| `label` | the name across the rectangle | one of the 24 name budgets |
| `point` | nothing; the region's own mark, which a hover or a tap opens | `SEA_LIMITS.pointPx` (4000) of box, or an exhausted budget |

The curated half is what the wall is read for, so a demoted pin is never the reason a cloud
loses its rows — but the pins do *spend* the budgets: twenty-two of them leave no row budget
for a cloud, and what is left of the screen is a name each while a name fits and a point once
it does not. `labelFontPx` sizes a name to the box it was given (0.6 em, 11 … 220 px).

Measured over the newest 2222 rows at the opening field of view: a 1032×691 view shows 12
pinned regions at 443×73 px and 3 clouds at 155×49 px, so the clouds keep their names there
and lose them on a phone-sized view, where the same cells project to 63×50 px.

The tier map is published to React only when a visible region's tier actually changes, and at
most once per `VIEW_MS` (120 ms), so a coasting pan writes styles every frame and re-renders
the wall twice a second at worst.

### The marks and the edges

`seaStars(graph, regions)` returns the marks over a packing: one star per region at its
centre, carrying the region and the mean lexical share (`RowTagReport.qarf`) it should be
outlined in, plus an edge per pair of tags one row's chips held together, heaviest first and
capped at `MAX_EDGES` (260) — with `maxRows` and `maxEdge` so the renderer can scale itself.
`starSize(rows, maxRows)` is the star's size; the field is one `Points` draw with `aSize` and
`aColor` attributes and a `uPixelsPerUnit` uniform, so a zoom does not re-upload geometry.

Edges are drawn along the wall rather than as chords: two tags at opposite longitudes are on
opposite sides of it, so the straight line between them passes through the camera. An edge is
sampled every `ARC_STEP` (3) degrees, dropped past `EDGE_SPAN` (120) degrees and faded by the
square of its own reach. `skyLegend(field, names, order)` lists every kind the taxonomy names —
zeros included — north to south, and `SeaView` prints it as the readout's last line so an
empty band reads as an unread seed rather than as an absent feature.

### Motion and zoom

The camera only ever turns on the spot and pans along the axis, and both halves of a drag are
a grab: the wall follows the pointer, so pulling right reveals what was to the left. Letting
go leaves the pan coasting, which `seaMotion.ts` owns in degrees and degrees per second:

| Field | Shipped | What it does |
|---|---|---|
| `transfer` | 0.9 | pointer speed handed to the coast at release |
| `friction` | 0.12 | speed lost per second; a coast travels `v / ln(1/friction)` degrees |
| `minSpeed` / `maxSpeed` | 3 / 360 | below this it has stopped; above it a flick may not outrun a hand |
| `wheelGain` | 60 | degrees a 100-unit wheel notch adds — about a quarter of the opening view |

`glideStep` carries the offset at the frame's own average speed, so the coast is
frame-rate independent; `glideRelease`, `glideWheel` and `glideAtRest` are the rest of it.
`treeCac['seaMomentum']` (0–100) is the one user control: 0 stops the sky the instant the
pointer lets go, 100 carries for seconds, and an absent or unreadable value leaves
`SEA_MOTION` standing, so a table that has never been told otherwise behaves as shipped.
A plain wheel pans; Ctrl or ⌘ with the wheel narrows the field of view, and with it the grid.

### Camera, pointer and readout

A horizontal drag carries the 360 degrees around; a vertical drag pans the wall by
translating the camera (`glide.offset × UNIT`). The grid follows in whole spacings — the band
`makeGrid` built is re-anchored to `round(offset / step) · step` — so it always covers the
view without the geometry growing, while the stars and edges sit at their own rise and travel
past the camera.

Sea level also tilts the aim by up to `SEA_FEEL.levelPitch` (6) degrees: up above the
horizon, down below it. A dive therefore looks into the deep while the star and its ring stay
overhead, which is what makes the wall read as exploration rather than a flat pan.

A click — pointer travel under `CLICK_SLOP` (5) pixels — selects the grid cell under the
pointer, outlines it and lists the tags that cell holds. That read happens once per click
into state, not per frame, so a coasting sky does not re-render React sixty times a second.
The direction comes from unprojecting the pointer rather than from a pick surface: the camera
stands on the axis, so the ray that left it is the ray that meets the wall.

The wall's regions are DOM (`SeaRegions.tsx`) rather than geometry, for the two things
three.js cannot give: text a browser finds with find-in-page, and rows that are links. The
loop projects each region's four corners and writes its own transform, width, height and
clip path — the clip is the quad those corners cut, because on a cylinder a region's box is
not the rectangle around them — so a pan costs style writes and no React render. A cloud
region's rows are the ones the seed already scored, so drawing them costs no query; a pinned
region is the subject rather than a sample of it, so it asks the tag index for its own rows —
the same query, and the same row box, the pin card itself draws.

`SeaView.tsx`'s own header carries the renderer's traps — `three` is WebGL 2 only, shaders
compile on the first frame rather than through `compileAsync`, and the canvas is owned by the
mount rather than by React — because they are facts about the renderer, not about the
reading.

### What has been measured

| Reading | Where it comes from |
|---|---|
| the packing, over the newest 2222 rows: 1 pin card (22 headings), 4542 nodes, 220 regions kept, a cloud region 299×53 px at the median and never below 18×14, the widest pin taking the column's whole 96 degrees at 114 px tall, 50 regions in front at once, the wall running 467 degrees of rise | `SEA_REGION`'s own doc comment (`src/ui/seaRegion.ts`) |
| the marks and the bands, over the real 37k-row table: 22 pinned tags, 1 alias, 123 related, 0 remote and 74 own | the star field's own legend (`skyLegend`, printed as the readout's last line) |

## The pin reading

The graph is read by what the pass *did* with each tag (`pinned`/`head`/`theme`/`own`), and
the other way round by how far a tag is from the curated half. `pinReach` partitions the nodes
once, so every node lands in exactly one band:

| Reach | What it is |
|---|---|
| `pinned` | a tag a pin card's `#tag` heading names |
| `alias` | a spelling or synonym of a pinned tag, kept as its own node rather than folded into it, so a table that spells one curated tag two ways says so |
| `related` | a tag the seed rows hold beside a pinned one: one co-occurrence step out |
| `remote` | two steps, through a tag that is itself related |
| `own` | nothing a pin reaches: its own cluster over the seed |

`buildTagGraph(pins, rows, reports, { keepAliases: true })` is what makes `alias` possible:
the namer would otherwise fold `DeepSeek` and `deepseek` into one node, and the mismatch is
exactly what the band is there to show. `tagGraphLayout(graph, { kind, ring })` reads whichever
taxonomy the caller names, so the disc and the wall draw the same graph without either owning
it; `seaRegions` reads `pinReach` on its own, which is why a change there moves every band of
the sea.

## The graph reading

The star files every tag onto a wall. The graph inverts that: it draws the tags as one object
and lets the rows read through them. A node is a tag, an edge joins two tags one row's chip
list held together (weighted by how many rows did), a node's radius is how many scored rows
kept it, and the pin cards' `#tag` headings are the roots the arrangement is built around.

The layout is radial and rooted: pins at the centre, heads on the ring around them, themes
between a head and the outer ring at that head's own angle — so a refinement reads as one with
the chip it refines — and a chip no head claims on the outermost ring. Each pin owns an angular
sector, so a pin's neighbourhood reads as one wedge however the ring fills up.

What makes it the `qarf` reading rather than any pass's is the **share** a node carries: the
mean lexical split of the rows that kept it, drawn on the node's outline — warm where the exact
lexical lists carried those rows, cool where the neighbour walks did. That is
`RowTagReport.qarf`, and it is the one thing this reading shows that no other reading does:
not what a tag is about, but *how the pass had to read the rows it is on*. A fixed-weighting
pass carries no share, and every node falls back to its own hue.

It needs width, so it is the same list opened in a window of its own rather than a seventh
panel mode: `graph` above the strip opens the page with `rgraph=1`, the list lays itself out as
the left two thirds and the graph takes the rest, and the app's own chrome — nav, user bar,
filter bar — is dropped so the two read together. Nothing is persisted and no second pass runs:
the wide view reads the reports the list is already showing.

| Piece | Where | Knows |
|---|---|---|
| `buildTagGraph`, `tagGraphLayout` | `src/ui/restGraph.ts` | tags, rows, reports, pins — no DOM, no pass |
| `RestGraph` | `src/ui/TagGraph.tsx` | the graph, and one click handler |
| the flag and the window | `src/ui/restGraphWindow.ts` | the URL, and the work area |

Live check: the disc has not been read against a populated table (the scratch browser profile
has an empty `tagDB_0`), so it is covered by render tests
(`test/startagfeed/restGraph.test.ts`) rather than by a live read; the empty state and the
two-pane layout were both seen in the running app.

## The bar and the settings rows

Everything a reader drives tagging from outside the list is `src/ui/tap.tsx`, and its own JSDoc
is where the contracts are:

- **the bar** — a floating toolbar holding the omnibox and four menus, movable by a drag handle
  (`BAR_DEFAULT` and a session-only `barPos`; nothing is persisted). The panels are
  `position: fixed` and placed by the bar (`dropStyle(below, spanLeft)`) rather than by their
  class, and the omnibox takes the toolbar's free width and reaches the screen's left edge while
  it is focused or holds a query — which is what `spanLeft` is for.
- **the omnibox** — matches the query as one substring against a row's `ref` or its `txt`, and
  shows, on focus with an empty query, the tags the rest list's own pass suggests
  (`restTagStore`) ahead of the most used ones. `Enter` opens the highlighted row,
  `Shift+Enter` tags it. The read path it feeds is [filter_search.md](filter_search.md#the-search-box).
- **the settings rows** — each `input-tree-*` sits in a `.picker-container` with an invisible
  native picker stretched over the row. A datalist filters itself by whatever the box holds, so
  focus parks the text in `data-keep` and empties the box, blur puts it back unless the row was
  edited (`data-typed`), and closing a panel unmounts a focused input without a blur at all —
  which is why saving on the way out is explicit (`savePendingRow`, `data-saved`). The row's
  value semantics (`snap_pin`'s empty value, the grouper list, the memory-only caches) are
  [greet.md](../greet.md) and [filter_search.md](filter_search.md#view-switch)'s.

## Review notes

- **The wall is the reading and the marks are its scale.** A region is the tag's claim on the
  wall; the star at its centre, its size and the edges among them are what make the shape of
  the table readable at a distance. The packing is therefore the thing to get right and the
  mark layer is a decoration over it: `seaStars` takes the regions rather than laying out tags
  itself, so the two can never disagree about where a tag is.
- **Every band of the sea comes from one partition.** `pinReach` decides the column, the
  spellings, the cluster runs and the strips; `kindOf` is the disc's own taxonomy and
  `seaRegions` does not read it unless a caller passes `kind`.
- **The vertical axis is time and detail, not distance.** The column orders by `recency`; the
  marks above a region read the same quantity. Read as hop count, the wall looks wrong.
- **Two screen-size facts decide what a reader sees**, and neither is in the table: the tier
  budget (above), and the quad each region's own corners project to — which is why the same
  table reads differently on a phone and on a wide view.
- **The stage is a background.** Only the sea's own route hands it the pointer, so a feature
  that wants a click on the wall has to earn it on that route alone; the readouts follow the
  same rule and hang below the user bar.
- **The cloud's edges still read as noise.** 123 related tags spread over the longitudes
  behind the pin column all reach back to it, so their arcs accumulate where they converge;
  the span cap and the squared fade keep that a wash, and lowering `MAX_EDGES` (260 → 140)
  was measured and changes nothing, because the fade has already dropped the tail it cuts.
- **A node's share hides who kept it.** The disc averages the share over the rows that kept a
  tag, so a tag a rare-token row and a paraphrastic row both kept reads as the middle and
  neither reading shows. Open: the node's hover names the row count, not its spread.
- **The widest node is not the most interesting one.** Support decides radius, and a rest
  list's pin headings sit on many rows, so a root can dwarf the term a burst actually shares.
  Roots are drawn at the centre in the pin's own hue so they read as axes rather than as
  findings.
- **The wide view is a second page over the same store**, so it re-scores rather than sharing
  the list's results — by design: nothing is persisted, and the two agree because they read
  the same rows, profile and filter.
- Not verifiable from the docs: the disc against a populated table. The wall, the tiers and
  the motion are all measured; the disc is not.

## Related

- [sTag.md](sTag.md) — the evidence a tag comes from; the chips, the tuner and the panel the
  readings are chosen in.
- [rstag.md](rstag.md) — the pass and the 3-stage chain, the knobs, the measurements, the risks.
- [filter_search.md](filter_search.md) — the read path the chips and the omnibox feed.
- [srcfeed.md](../srcfeed.md) — the feeds that hand `tid`-less rows to `tagRows`.
- [greet.md](../greet.md) — the settings tree a bar row writes.
- `src/ui/restGraph.ts`, `src/ui/restGraphWindow.ts`, `src/ui/TagGraph.tsx`,
  `src/ui/restCue.ts`, `src/ui/seaSky.ts`, `src/ui/seaRegion.ts`, `src/ui/seaStars.ts`,
  `src/ui/seaScene.ts`, `src/ui/seaMotion.ts`, `src/ui/seaPinGraph.ts`, `src/ui/SeaRegions.tsx`,
  `src/ui/SeaView.tsx`, `src/ui/tap.tsx`.
- `test/startagfeed/seaSky.test.ts`, `test/startagfeed/seaRegion.test.ts`,
  `test/startagfeed/seaStars.test.ts`, `test/startagfeed/seaMotion.test.ts`,
  `test/startagfeed/restGraph.test.ts`.
