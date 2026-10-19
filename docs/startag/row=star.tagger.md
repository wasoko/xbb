# Star tagger row (star.tagger)

The sea (`#/`) builds its taxonomy from the pin cards' `#tag` headings and the
newest `type='tab'`/`type='tag'` rows, scored by the `qarf` profile. This row is
the only customization point for that seed, and it is also where the sea writes
the taxonomy it built. A missing row is seeded with the template below; a key
left commented or absent changes nothing.

The dialect is local to `src/starTagger.ts` and shares no parser with
`w.feed.md`: `##` opens a section, `key: value` lines under `## Setup` are
overrides, and `## Taxonomy` is generated. The helpers are short and copied
rather than imported from the feed document.

## Setup

```md
# star.tagger

## Setup
# base: 5000
# trace: 555
# maxGraph: 1111
# alias: js = javascript, k8s = kubernetes
# reset: no

## Taxonomy
the sea writes this section on each seed.

## Notes
...
```

| Key | Default | Meaning |
|---|---|---|
| `base` | 5000 | Ceiling on the newest `type='tab'` and `type='tag'` rows pulled as qarf input. The scan is newest `tid` first; a larger `base` sees a wider taxonomy and spends more scan/score time. Capped at 50,000. |
| `trace` | 555 | Maximum graph nodes written into the table. `0` writes no rows, leaving the header, timings, and relation sections. Never writes more than `maxGraph`. |
| `maxGraph` | 1111 | Maximum nodes built into the taxonomy graph before the table is cut. Capped at 5,000. |
| `alias` | none | `alias = tag` pairs, comma-separated. An explicit alias wins over the spelling similarity merge. Chains resolve transitively; a cycle is noted in the trace instead of looping. |
| `reset` | no | `yes` rebuilds `## Taxonomy` once on the next seed and is then written back as `no`. It never edits tags on `db.das` rows. |
| `alpha` / `floor` / `ceil` | `DEFAULT_QARF` | Optional qarf weighting overrides; only the keys written here replace the profile's values. |

A pin card is a `type='md'` row tagged `pin` whose ref starts `pin`; there is no
`type='pin'` row. Its headings supply the priority tags, and the parser expands a
compound heading tag into the forms the trie can match:

| Heading tag | Also matches |
|---|---|
| `#turnOver_Alpha` | `turnOver_Alpha`, `turnover`, `alpha`, `turn over alpha`, `turn`, `over` |
| `#kelly_Ito` | `kelly`, `ito`, `kelly ito` |
| `#portfolioRisk` | `portfolio risk`, `portfolio`, `risk` |

The expansion is `srctag.tagSurfaceForms`: the original, its lowercased form, the
separator-spaced and camelCase-spaced phrases, and the individual words. The
priority tag itself keeps its written spelling, so the graph and table still show
`turnOver_Alpha` rather than one node per word.

The two alias helpers are deliberately local and short, copied rather than
imported from the feed document:

```ts
const aliasKey = (tag: string) => tag.trim().toLowerCase();
const foldAlias = (tag: string, map: Map<string, string>) => map.get(aliasKey(tag)) ?? tag;
```

The row is read with `useLiveQuery`. Editing `## Setup` changes the fingerprint
and re-seeds the sea; writing the generated `## Taxonomy` does not. `reset: yes`
seeds once and is cleared, so the write that clears it is not itself a second
seed.

## Taxonomy

The sea writes this section after every seed. It is generated: edit `## Setup`
and `## Notes`, not this section.

```md
seeded 2026-10-17T00:00:00.000Z · rows 5000/4987 · pins 1 · nodes 1111/1111 · trace 555 · edges 2480 · λ̄ 0.541 · α 1.00 · floor 0.10 · ceil 0.90
time: config 1ms · scan 42ms · score 287ms · graph 9ms · total 339ms

| tag | reach | kind | score | weight | freq | λ | burst | top |
|---|---|---|---|---|---|---|---|---|
| deepseek | pinned | pinned | 1.000 | 42 | 57 | 0.43 | 3 | bm25 |
| portfolioRisk | related | head | 0.900 | 12 | 14 | 0.71 | 7 | textrank |
```

| Column | Meaning |
|---|---|
| `tag` | Graph node's canonical display tag. Aliases are folded before this name is chosen. |
| `reach` | Distance from the curated half: `pinned`, `alias`, `related`, `remote`, or `own`. |
| `kind` | What the pass did with the tag: `pinned`, `head`, `theme`, or `own`. |
| `score` | Best per-row suggestion score the tag received. |
| `weight` | Distinct scored rows that kept the tag. |
| `freq` | Raw occurrences in heading tags and report tag entries, pins included. |
| `λ` | Mean lexical share of the rows that kept the tag (`qarf`). |
| `burst` | Cluster of the highest-scoring row. |
| `top` | Channel that carried that highest-scoring row (`bm25`, `textrank`, `priority`, …). |

The relation sections are not cut by `trace`; they always describe the whole
graph the table was read from:

- `### Aliases` — explicit `alias:` folds, with occurrence counts.
- `### Synonyms` — spelling variants merged by `nodeNamer`, e.g. `DeepSeek-V3 → DeepSeek`.
- `### Themes` — promoted `head/term` sub-tags and the head they refine.
- `### Bursts` — cluster index, row count, and the tags the cluster scored highest.
- `### Web` — the heaviest co-occurrence edges, `tag ↔ tag ×weight`.

`trace: 555` dumps at most 555 nodes; `maxGraph: 1111` is the default full build
limit, so a 555-node table is a window into a larger graph rather than the whole
graph. A seed whose table and relation sections are unchanged leaves the row as
it is, including the `time:` line; `reset: yes` refreshes both. `trace` is an
output cap only: saving the table does **not** speed up the next mount. The sea still scans `db.das` and runs qarf for rows, reports,
regions, and the suggestion store; the graph build is small beside the score
stage. The timing line is the instrument for the real trade-off: raising
`base` to 10,000 or more sees more tags but spends more scan and score time.
Caching the whole seed (rows, reports, and taxonomy) would be a real speedup, but
it needs invalidation by the window's newest `tid`; this row deliberately does
not do that.

## Notes

These footnotes are for the Setup keys and the generated table, in plain
language.

- `base` is how many recent notes the star reads. 5000 is the default; 10000 is
  slower but sees more. Only `tab` and `tag` rows are read, and pin cards are
  read separately.[^base]
- `trace` is how many tags the table prints. 555 is the default; 0 writes no
  rows, leaving the header, timings, and relation sections.[^trace]
- `maxGraph` is how many tags the graph may hold before the table is cut. 1111 is
  the default; the table can never print more than this.[^maxgraph]
- `alias` gives another spelling for the same tag: `js = javascript` makes `js`
  count as `javascript` in the priority tags, the scores, and the graph.[^alias]
- `reset: yes` asks for one rebuild of the generated section. It clears itself to
  `no`, and it never changes the tags saved on your rows.[^reset]
- `score` is the best single-row evidence for a tag; `weight` is how many rows
  kept it; `freq` counts every mention; `λ` is how much of the row's score came
  from the exact lexical lists rather than the neighbour walks.[^columns]
- The `## Taxonomy` section is generated. Put your own prose under `## Notes`,
  where it is never overwritten.[^notes]

[^base]: A larger `base` is the main lever for a better taxonomy, and the
    `time:` line shows what it costs.
[^trace]: `trace` is an output cap. A smaller value keeps the row readable; it
    does not skip scoring or graph building.
[^maxgraph]: Pins and their direct neighbours always survive the graph cap.
[^alias]: Alias keys and values are matched case-insensitively; a chain such as
    `js = javascript, javascript = ecmascript` resolves to `ecmascript`.
[^reset]: A reset is one shot. Rebuilds are otherwise skipped when the generated
    section is unchanged.
[^columns]: `λ` is absent on a fixed-weighting pass; the table prints `-` then.
[^notes]: The generated section is replaced as one block, so old trace rows never
    accumulate.
