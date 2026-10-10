/**
 * @vitest-environment happy-dom
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, type Da } from '../src/sdb';
import {
  groupByDt, groupByDtVisit, groupBySession, groupRest, isRestGrouperScript, isTagGrouper,
  restAim, restDynAdapters, restDynCapable, restGroupsFor, restHyperScore, restProfileMap,
  restTagContributors, restTagMap, restTagStore, restTextMap, restVizMode, RECR_CONFIG_LABEL,
  REST_PROFILES, RSDT_GROUPER, RSFREQ_GROUPER, RSSESS_GROUPER, RSTAG_GROUPER, RSTAG_LIMIT,
  RSTRANK_GROUPER, RSTEXT_GROUPER, RSTEXT_LIMIT, RSTT_GROUPER, UNDATED_LABEL,
} from '../src/ui/restGrouper';
import type { RowTagReport } from '../src/srctag';

const T0 = Date.UTC(2026, 9, 5, 10, 0, 0);

const row = (tid: number, dt: unknown): Da =>
  ({ tid, ref: `r${tid}.md`, txt: `row ${tid}`, type: 'md', dt: dt as Date, rec: {} });

/** Row carrying a Chrome visit time in `rec`. */
const rowV = (tid: number, dt: unknown, visitTime?: number): Da =>
  ({ ...row(tid, dt), rec: visitTime === undefined ? {} : { visitTime } });

/** tids per block, in render order. */
const tids = (rows: Da[]) => groupByDt(rows).map((g) => g.items.map((d) => d.tid));

beforeEach(async () => {
  await db.das.clear();
});

describe('groupByDt', () => {
  it('splits rows into one block per distinct dt, newest first', () => {
    expect(tids([row(1, new Date(T0)), row(2, new Date(T0)), row(3, new Date(T0 + 1000))]))
      .toEqual([[3], [2, 1]]);
  });

  it('sorts rows by tid descending before grouping', () => {
    expect(tids([row(1, new Date(T0)), row(3, new Date(T0)), row(2, new Date(T0))]))
      .toEqual([[3, 2, 1]]);
  });

  it('buckets an ISO string and an epoch number of the same instant together', () => {
    expect(tids([row(1, new Date(T0).toISOString()), row(2, T0)])).toEqual([[2, 1]]);
  });

  it('trails rows without a usable dt in one undated block', () => {
    const groups = groupByDt([row(1, new Date(T0)), row(2, undefined), row(3, 'not a date')]);
    expect(groups.map((g) => g.key)).toEqual([String(T0), UNDATED_LABEL]);
    expect(groups[1].items.map((d) => d.tid)).toEqual([3, 2]);
  });

  it('labels a dated block', () => {
    expect(groupByDt([row(1, new Date(T0))])[0].label).not.toBe('');
  });

  it('returns no block for an empty list', () => {
    expect(groupByDt([])).toEqual([]);
  });
});

describe('restGroupsFor', () => {
  it('leaves the rows in one unlabelled block when the grouper is unset or none', () => {
    for (const grouper of [undefined, '', 'none']) {
      expect(restGroupsFor([row(1, new Date(T0))], grouper))
        .toEqual([{ key: '', label: '', items: [row(1, new Date(T0))] }]);
    }
  });

  it('returns no block for an empty flat list', () => {
    expect(restGroupsFor([], 'none')).toEqual([]);
  });

  it('defers to the script path for a ref', () => {
    expect(restGroupsFor([row(1, new Date(T0))], 'restGroupers/byRef.ts')).toBeNull();
    expect(isRestGrouperScript('restGroupers/byRef.ts')).toBe(true);
    expect(isRestGrouperScript('rsdt')).toBe(false);
  });
});

describe('groupByDtVisit (rsid)', () => {
  it('splits each date block into visit-time subgroups, newest first', () => {
    const groups = groupByDtVisit([
      rowV(1, new Date(T0), 300),
      rowV(2, new Date(T0), 100),
      rowV(3, new Date(T0), 300),
    ]);
    expect(groups.map((g) => g.key)).toEqual([String(T0)]);
    expect(groups[0].subgroups?.map((s) => s.key)).toEqual(['300', '100']);
    expect(groups[0].subgroups?.[0].items.map((d) => d.tid)).toEqual([3, 1]);
    expect(groups[0].items).toEqual([]);
  });

  it('keeps rows without a visit time directly under the date heading', () => {
    const groups = groupByDtVisit([rowV(1, new Date(T0), 200), rowV(2, new Date(T0))]);
    expect(groups[0].subgroups?.map((s) => s.key)).toEqual(['200']);
    expect(groups[0].items.map((d) => d.tid)).toEqual([2]);
  });

  it('renders a date block with no visit times exactly like rsdt', () => {
    const rows = [rowV(1, new Date(T0)), rowV(2, new Date(T0))];
    expect(groupByDtVisit(rows)).toEqual(groupByDt(rows));
  });

  it('keeps the date level ordered newest first', () => {
    const groups = groupByDtVisit([rowV(1, new Date(T0), 5), rowV(2, new Date(T0 + 1000), 5)]);
    expect(groups.map((g) => g.key)).toEqual([String(T0 + 1000), String(T0)]);
  });

  it('resolves as a built-in rather than a script ref', () => {
    expect(isRestGrouperScript('rsid')).toBe(false);
    expect(restGroupsFor([rowV(1, new Date(T0), 5)], 'rsid')?.[0].key).toBe(String(T0));
  });
});

describe('groupBySession (rsess)', () => {
  const recrRow = (tid: number, ref: string, txt = `row ${tid}`, stamp?: number): Da =>
    ({ tid, ref, type: 'recr', txt, rec: {}, ...(stamp ? { modAt: new Date(stamp) } : {}) });

  it('blocks recr rows by session, newest session first', () => {
    const groups = groupBySession([
      recrRow(1, 'sess/a/node/n1', 'a1', T0),
      recrRow(2, 'sess/b/node/n1', 'b1', T0 + 1000),
      recrRow(3, 'sess/a/meta'),
    ]);
    expect(groups.map((g) => g.key)).toEqual(['b', 'a']);
    expect(groups[1].items.map((d) => d.tid)).toEqual([3, 1]);
  });

  it('names a session block with its meta title when that row holds one', () => {
    const groups = groupBySession([
      recrRow(1, 'sess/a/meta', JSON.stringify({ title: 'Fix the parser' })),
      recrRow(2, 'sess/a/node/n1'),
    ]);
    expect(groups[0].label).toBe('sess/a · Fix the parser');
  });

  it('falls back to the session id for a placeholder or unreadable title', () => {
    expect(groupBySession([
      recrRow(1, 'sess/a/meta', '{"title":"New Session"}'),
      recrRow(2, 'sess/a/node/n1'),
    ])[0].label).toBe('sess/a');
    expect(groupBySession([recrRow(1, 'sess/a/meta', 'not json')])[0].label).toBe('sess/a');
  });

  it('trails the non-session recr rows in one block', () => {
    const groups = groupBySession([
      recrRow(1, 'settings/main'),
      recrRow(2, 'tools/read_file'),
      recrRow(3, 'sess/a/node/n1'),
    ]);
    expect(groups.map((g) => g.key)).toEqual(['a', RECR_CONFIG_LABEL]);
    expect(groups[1].items.map((d) => d.tid)).toEqual([2, 1]);
  });

  it('resolves as a built-in rather than a script ref', () => {
    expect(isRestGrouperScript(RSSESS_GROUPER)).toBe(false);
    expect(restGroupsFor([recrRow(1, 'settings/main')], RSSESS_GROUPER)?.[0].key)
      .toBe(RECR_CONFIG_LABEL);
  });
});

describe('groupRest scripts', () => {
  const putSrc = (ref: string, txt: string) =>
    db.das.put({ ref, type: 'src', txt, tags: [], rec: {} });

  it('runs a type=src row with the rows as args and uses its blocks', async () => {
    await putSrc('restGroupers/byRef.ts',
      'return [{ key: "all", label: "By ref", items: ctx.args.das }]');
    const groups = await groupRest([row(1, new Date(T0))], 'restGroupers/byRef.ts');
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ key: 'all', label: 'By ref' });
    expect(groups[0].items.map((d) => d.tid)).toEqual([1]);
  });

  it('accepts a module row that exports a default function', async () => {
    await putSrc('restGroupers/mod.ts',
      'export default (ctx) => [{ key: "m", label: "Mod", items: ctx.args.das }]');
    const groups = await groupRest([row(2, new Date(T0))], 'restGroupers/mod.ts');
    expect(groups.map((g) => g.key)).toEqual(['m']);
  });

  it('keeps a visit-time level a script returned', async () => {
    await putSrc('restGroupers/nested.ts',
      'return [{ key: "d", label: "Day", subgroups: [{ label: "Vis", items: ctx.args.das }] }]');
    const groups = await groupRest([row(1, new Date(T0))], 'restGroupers/nested.ts');
    expect(groups[0].items).toEqual([]);
    expect(groups[0].subgroups?.[0].label).toBe('Vis');
    expect(groups[0].subgroups?.[0].items.map((d) => d.tid)).toEqual([1]);
  });

  it('falls back to one flat block when the row is missing', async () => {
    const groups = await groupRest([row(1, new Date(T0))], 'restGroupers/none.ts');
    expect(groups).toEqual([{ key: '', label: '', items: [row(1, new Date(T0))] }]);
  });

  it('falls back to one flat block when the body throws', async () => {
    await putSrc('restGroupers/boom.ts', 'throw new Error("boom")');
    const groups = await groupRest([row(1, new Date(T0))], 'restGroupers/boom.ts');
    expect(groups[0].key).toBe('');
    expect(groups[0].items.map((d) => d.tid)).toEqual([1]);
  });

  it('falls back to one flat block when the result is not an array of blocks', async () => {
    await putSrc('restGroupers/bad.ts', 'return "nope"');
    const groups = await groupRest([row(1, new Date(T0))], 'restGroupers/bad.ts');
    expect(groups[0].key).toBe('');
  });
});

describe('rstag', () => {
  const tagged = (tid: number, txt: string, tags: string[] = []): Da =>
    ({ tid, ref: `r${tid}.md`, txt, type: 'md', dt: new Date(T0), tags, rec: {} });

  it('resolves as a built-in whose blocks are exactly rsdt', () => {
    const rows = [row(1, new Date(T0)), row(2, new Date(T0)), row(3, new Date(T0 + 1000))];
    expect(isRestGrouperScript(RSTAG_GROUPER)).toBe(false);
    expect(restGroupsFor(rows, RSTAG_GROUPER)).toEqual(groupByDt(rows));
  });

  it('keys srctag reports by tid and explains every suggested tag', async () => {
    const map = await restTagMap([
      tagged(1, 'react hooks tutorial'),
      tagged(2, 'react hooks guide'),
      tagged(3, 'react state'),
    ]);
    expect([...map.keys()].sort()).toEqual([1, 2, 3]);
    const report = map.get(1)!;
    expect(report.dim).toBe('tid');
    expect(report.tags.map((t) => t.tag)).toContain('react');
    const react = report.tags.find((t) => t.tag === 'react')!;
    expect(react.channels.reduce((n, c) => n + c.contribution, 0)).toBeCloseTo(react.score, 6);
  });

  it('takes the rows\u2019 own tags as the trie priorities and drops the tags it already carries', async () => {
    const map = await restTagMap([
      tagged(1, 'react hooks tutorial', ['react']),
      tagged(2, 'react hooks guide', ['react']),
    ]);
    const report = map.get(1)!;
    expect(report.tags.map((t) => t.tag)).not.toContain('react');
    expect(report.tags.map((t) => t.tag)).toContain('hooks');
  });

  it('scores only the newest rows within the cap', async () => {
    const rows = Array.from({ length: RSTAG_LIMIT + 5 }, (_, i) => tagged(i + 1, `row ${i}`));
    const map = await restTagMap(rows);
    expect(map.size).toBe(RSTAG_LIMIT);
    expect(map.has(RSTAG_LIMIT + 5)).toBe(true);
    expect(map.has(5)).toBe(false);
  });
});

describe('rstext', () => {
  const site = (tid: number, txt: string, url: string, tags: string[] = []): Da =>
    ({ tid, ref: url, txt, type: 'tab', dt: new Date(T0), tags, rec: { url } });

  it('resolves as a built-in whose blocks are exactly rsdt', () => {
    const rows = [row(1, new Date(T0)), row(2, new Date(T0)), row(3, new Date(T0 + 1000))];
    expect(isRestGrouperScript(RSTEXT_GROUPER)).toBe(false);
    expect(restGroupsFor(rows, RSTEXT_GROUPER)).toEqual(groupByDt(rows));
  });

  it('reads each row on the visit-time dimension and leaves TF-IDF out of the channels', async () => {
    const map = await restTextMap([
      site(1, 'react hooks tutorial', 'https://react.dev/learn', ['react']),
      site(2, 'react hooks guide', 'https://react.dev/reference', ['react']),
    ]);
    const report = map.get(1)!;
    expect(report.dim).toBe('visitTime');
    const hooks = report.tags.find((t) => t.tag === 'hooks')!;
    expect(hooks.channels.map((c) => c.channel)).not.toContain('tfidf');
    expect(hooks.channels.map((c) => c.channel)).toContain('textRank');
  });

  it('lifts a term its own site shares, and never invents one the row lacks', async () => {
    const map = await restTextMap([
      site(1, 'deep learning framework', 'https://pytorch.org/docs'),
      site(2, 'site map', 'https://example.com/a'),
      site(3, 'torch optimizer notes', 'https://pytorch.org/tutorials'),
    ]);
    // `pytorch` occurs on both pytorch.org rows, so the site pool ranks it for row 1
    const one = map.get(1)!;
    const pytorch = one.tags.find((t) => t.tag === 'pytorch')!;
    expect(pytorch.channels.map((c) => c.channel)).toContain('clusterRank');
    // a candidate must occur in the row's own text, so the sibling's `torch` never lands here
    expect(one.tags.map((t) => t.tag)).not.toContain('torch');
    expect(map.get(2)!.tags.map((t) => t.tag)).not.toContain('pytorch');
  });

  it('scores only the newest rows within the cap', async () => {
    const rows = Array.from({ length: RSTEXT_LIMIT + 5 }, (_, i) =>
      site(i + 1, `row ${i}`, `https://s${i % 3}.example.com/${i}`));
    const map = await restTextMap(rows);
    expect(map.size).toBe(RSTEXT_LIMIT);
    expect(map.has(RSTEXT_LIMIT + 5)).toBe(true);
    expect(map.has(5)).toBe(false);
  });
});

describe('restTagStore', () => {
  /** A report carrying just the tags the ranking reads. */
  const report = (tid: number, tags: [string, number][]): RowTagReport => ({
    tid, ref: `r${tid}.md`, dim: 'tid',
    window: { lo: 0, hi: 0, radius: 0, indices: [] }, cluster: 0,
    tags: tags.map(([tag, score]) => ({ tag, score, channels: [], text: '' })),
  });

  it('ranks by how many rows suggest a tag, then by best score', () => {
    const rows = [row(1, T0), row(2, T0), row(3, T0)];
    restTagStore.set(new Map([
      [1, report(1, [['react', 0.4], ['vue', 0.9]])],
      [2, report(2, [['react', 0.3]])],
      [3, report(3, [])],
    ]), rows);

    const ranked = restTagStore.rank(3);
    expect(ranked.map((h) => h.tag)).toEqual(['react', 'vue']);
    expect(ranked[0].rows.map((r) => r.tid)).toEqual([1, 2]);
    expect(ranked[0].score).toBe(0.4);
    expect(ranked[1].rows.map((r) => r.tid)).toEqual([1]);
  });

  it('returns at most n hints and reports the pass size', () => {
    restTagStore.set(new Map([
      [1, report(1, [['a', 0.5], ['b', 0.4], ['c', 0.3]])],
    ]), [row(1, T0)]);

    expect(restTagStore.size).toBe(1);
    expect(restTagStore.rank(2).map((h) => h.tag)).toEqual(['a', 'b']);
  });

  it('ignores a report whose row is absent from the published rows', () => {
    restTagStore.set(new Map([[1, report(1, [['react', 0.5]])]]), []);
    expect(restTagStore.rank(3)).toEqual([]);
  });

  it('notifies subscribers on every pass and stops after unsubscribe', () => {
    let calls = 0;
    const off = restTagStore.subscribe(() => { calls++; });
    restTagStore.set(new Map(), []);
    expect(calls).toBe(1);
    off();
    restTagStore.set(new Map(), []);
    expect(calls).toBe(1);
  });
});

describe('algorithm groupers (rsfreq/rstrank/rstt)', () => {
  const site = (tid: number, txt: string, url: string, tags: string[] = []): Da =>
    ({ tid, ref: url, txt, type: 'tab', dt: new Date(T0), tags, rec: { url } });

  const pin = (txt: string): Da =>
    ({ tid: -1, ref: 'pin/demo.md', txt, type: 'md', tags: [], rec: {} });

  it('resolves as built-ins whose blocks are exactly rsdt', () => {
    const rows = [row(1, new Date(T0)), row(2, new Date(T0)), row(3, new Date(T0 + 1000))];
    for (const grouper of [RSFREQ_GROUPER, RSTRANK_GROUPER, RSTT_GROUPER]) {
      expect(isRestGrouperScript(grouper)).toBe(false);
      expect(restGroupsFor(rows, grouper)).toEqual(groupByDt(rows));
      expect(isTagGrouper(grouper)).toBe(true);
      expect(REST_PROFILES[grouper]).toBeDefined();
    }
    expect(isTagGrouper(RSTAG_GROUPER)).toBe(true);
    expect(isTagGrouper(RSDT_GROUPER)).toBe(false);
    expect(isTagGrouper(undefined)).toBe(false);
  });

  it('scores rsfreq on TF-IDF alone', async () => {
    const map = await restProfileMap([
      site(1, 'react hooks tutorial', 'https://react.dev/learn'),
      site(2, 'react hooks guide', 'https://react.dev/reference'),
    ], RSFREQ_GROUPER, { minScore: 0.01, aim: false });
    const report = map.get(1)!;
    expect(report.dim).toBe('tid');
    const hooks = report.tags.find((t) => t.tag === 'hooks')!;
    expect(hooks.channels.map((c) => c.channel)).toContain('tfidf');
    expect(hooks.channels.map((c) => c.channel)).not.toContain('textRank');
  });

  it('scores rstt on the trie the pin card builds', async () => {
    const pins = [pin('## reading list #react #hooks')];
    const map = await restProfileMap([
      site(1, 'react hooks tutorial', 'https://react.dev/learn'),
      site(2, 'vue guide', 'https://vuejs.org'),
    ], RSTT_GROUPER, undefined, { pins });
    const report = map.get(1)!;
    expect(report.tags.map((t) => t.tag)).toContain('react');
    expect(report.tags.find((t) => t.tag === 'react')!.channels.map((c) => c.channel))
      .toContain('keyword');
    expect(map.get(2)!.tags).toEqual([]);
  });

  it('falls back to the scored rows own tags when no pin card is supplied', async () => {
    const map = await restProfileMap([
      site(1, 'react hooks tutorial', 'https://react.dev/learn'),
      site(2, 'react state', 'https://react.dev/reference', ['react']),
    ], RSTT_GROUPER);
    expect(map.get(1)!.tags.map((t) => t.tag)).toContain('react');
    // the row that carries the tag is not told to add it again
    expect(map.get(2)!.tags.map((t) => t.tag)).not.toContain('react');
  });

  it('moves a pass between readings with the window switch', async () => {
    const rows = [
      site(1, 'pytorch docs deep learning', 'https://pytorch.org/docs'),
      site(2, 'site map', 'https://example.com/a'),
      site(3, 'pytorch tutorials torch optimizer', 'https://pytorch.org/tutorials'),
    ];
    const byTid = await restProfileMap(rows, RSTRANK_GROUPER);
    expect(byTid.get(1)!.dim).toBe('tid');

    const byDomain = await restProfileMap(rows, RSTRANK_GROUPER, { mode: 'domain' });
    expect(byDomain.get(1)!.dim).toBe('visitTime');
    // `pytorch` is in both pytorch.org titles and central to that pool, which is
    // the evidence the tid window cannot pool
    expect(byDomain.get(1)!.tags.map((t) => t.tag)).toContain('pytorch');
  });

  it('reads the URL as a channel only when the tuner asks for it', async () => {
    const pins = [pin('## topic #pytorch')];
    const rows = [site(1, 'React docs', 'https://pytorch.org/learn')];
    const off = await restProfileMap(rows, RSTT_GROUPER, undefined, { pins });
    const on = await restProfileMap(rows, RSTT_GROUPER, { urls: true }, { pins });
    expect(off.get(1)!.tags.map((t) => t.tag)).not.toContain('pytorch');
    expect(on.get(1)!.tags.map((t) => t.tag)).toContain('pytorch');
  });

  it('folds the graph knobs over the profile', async () => {
    const rows = [
      site(1, 'pytorch docs', 'https://pytorch.org/docs'),
      site(2, 'pytorch guide', 'https://pytorch.org/guide'),
    ];
    const base = await restProfileMap(rows, RSTRANK_GROUPER, { minScore: 0.01 });
    const cut = await restProfileMap(rows, RSTRANK_GROUPER, { minScore: 0.01, rank: { minLength: 6 } });
    expect(base.get(1)!.tags.map((t) => t.tag)).toContain('docs');
    // a 6-character floor takes `docs` out of the co-occurrence graph entirely
    expect(cut.get(1)!.tags.map((t) => t.tag)).not.toContain('docs');
  });

  it('folds a tuner override over the profile', () => {
    const profile = REST_PROFILES[RSFREQ_GROUPER];
    expect(restHyperScore(profile).tfidf).toBe(1);
    expect(restHyperScore(profile).topK).toBe(profile.score.topK);
    const tuned = restHyperScore(profile, { weights: { tfidf: 0.2 }, topK: 9, minScore: 0.7 });
    expect(tuned.tfidf).toBe(0.2);
    expect(tuned.topK).toBe(9);
    expect(tuned.minScore).toBe(0.7);
    // a knob the profile does not expose is left alone
    expect(restHyperScore(profile, { weights: { suggest: 1 } }).suggest).toBe(0);
  });

  it('scores only the newest rows within the tuner cap', async () => {
    const rows = Array.from({ length: 12 }, (_, i) =>
      site(i + 1, `react row ${i}`, `https://s${i}.example.com/${i}`));
    const map = await restProfileMap(rows, RSTT_GROUPER, { limit: 3 }, { pins: [pin('# topic #react')] });
    expect(map.size).toBe(3);
    expect(map.has(12)).toBe(true);
    expect(map.has(3)).toBe(false);
  });
});

describe('restTagContributors', () => {
  const report = (tid: number, tags: string[]): RowTagReport => ({
    tid, ref: `r${tid}.md`, dim: 'tid',
    window: { lo: 0, hi: 0, radius: 0, indices: [] }, cluster: 0,
    tags: tags.map((tag) => ({ tag, score: 1, channels: [], text: '' })),
  });

  it('lists the rows proposing each tag, in pass order', () => {
    const rows = [row(1, T0), row(2, T0), row(3, T0)];
    const out = restTagContributors(rows, new Map([
      [1, report(1, ['react'])],
      [2, report(2, ['react', 'vue'])],
      [3, report(3, [])],
    ]));
    expect(out.get('react')!.map((r) => r.tid)).toEqual([1, 2]);
    expect(out.get('vue')!.map((r) => r.tid)).toEqual([2]);
    expect(out.has('nope')).toBe(false);
  });

  it('skips rows the pass did not report', () => {
    const out = restTagContributors([row(9, T0)], new Map([[1, report(1, ['react'])]]));
    expect(out.size).toBe(0);
  });
});

describe('the five tag groupers as profiles', () => {
  const site = (tid: number, txt: string, url: string, tags: string[] = []): Da =>
    ({ tid, ref: url, txt, type: 'tab', dt: new Date(T0), tags, rec: { url } });

  const pin = (txt: string): Da =>
    ({ tid: -1, ref: 'pin/demo.md', txt, type: 'md', tags: [], rec: {} });

  it('reproduces the read-path passes from their profiles', async () => {
    const rows = [
      site(1, 'react hooks tutorial', 'https://react.dev/learn'),
      site(2, 'react hooks guide', 'https://react.dev/reference'),
      site(3, 'vue guide', 'https://vuejs.org/guide'),
    ];
    // `rstag` and `rstext` are the same passes the two read paths run, reached
    // through `restProfileMap` so one code path serves all five groupers
    expect([...(await restProfileMap(rows, RSTAG_GROUPER))])
      .toEqual([...(await restTagMap(rows))]);
    expect([...(await restProfileMap(rows, RSTEXT_GROUPER))])
      .toEqual([...(await restTextMap(rows))]);
  });

  it('defaults aim on for the algorithm groupers and off for the read paths', () => {
    for (const grouper of [RSFREQ_GROUPER, RSTRANK_GROUPER, RSTT_GROUPER]) {
      expect(restAim(REST_PROFILES[grouper]), grouper).toEqual({});
    }
    expect(restAim(REST_PROFILES[RSTAG_GROUPER])).toBe(false);
    expect(restAim(REST_PROFILES[RSTEXT_GROUPER])).toBe(false);
    expect(restAim(REST_PROFILES[RSTAG_GROUPER], { aim: true, aimMin: 0.2, promoteMin: 4 }))
      .toEqual({ aimMin: 0.2, promoteMin: 4 });
    expect(restAim(REST_PROFILES[RSTT_GROUPER], { aim: false })).toBe(false);
  });

  it('starts every grouper on the chips reading and follows the switch', () => {
    for (const grouper of Object.keys(REST_PROFILES)) {
      expect(restVizMode(REST_PROFILES[grouper]), grouper).toBe('chips');
    }
    expect(restVizMode(REST_PROFILES[RSTT_GROUPER], { viz: 'keywords' })).toBe('keywords');
  });

  it('offers the dyn flag only where a dynamic channel carries weight', () => {
    expect(restDynCapable(REST_PROFILES[RSTAG_GROUPER])).toBe(true);
    for (const grouper of [RSTEXT_GROUPER, RSFREQ_GROUPER, RSTRANK_GROUPER, RSTT_GROUPER]) {
      expect(restDynCapable(REST_PROFILES[grouper]), grouper).toBe(false);
    }
  });

  it('focuses an algorithm pass and promotes the term its burst shares', async () => {
    const pins = [pin('## reading #react')];
    const rows = [
      site(1, 'react hooks guide', 'https://react.dev/1'),
      site(2, 'react hooks state', 'https://react.dev/2'),
      site(3, 'react hooks docs', 'https://react.dev/3'),
    ];
    // the priority weight is raised so the curated tag, not the shared title term,
    // is the tag each row keeps first; the cut-off is opened right up so the shared
    // term stays in the pre-focus list the promote half reads
    const map = await restProfileMap(
      rows, RSFREQ_GROUPER, { weights: { priority: 2 }, minScore: 0.05 }, { pins },
    );
    const tags = map.get(1)!.tags;
    expect(tags[0].tag).toBe('react');
    expect(tags.map((t) => t.tag)).toContain('react/hooks');
    expect(tags.find((t) => t.tag === 'react/hooks')!.origin).toBe('sub');
  });

  it('leaves the rows raw when the aim pass is off', async () => {
    const rows = [
      site(1, 'react hooks guide', 'https://react.dev/1'),
      site(2, 'react hooks state', 'https://react.dev/2'),
      site(3, 'react hooks docs', 'https://react.dev/3'),
    ];
    const tags = (await restProfileMap(rows, RSFREQ_GROUPER, { aim: false, minScore: 0.05 }))
      .get(1)!.tags;
    expect(tags.some((t) => t.origin === 'sub')).toBe(false);
    expect(tags.length).toBeGreaterThan(1);
  });

  it('degrades to the static channels when the store holds no adapter row', async () => {
    const set = await restDynAdapters();
    expect(set.embed).toBeUndefined();
    expect(set.errors.length).toBeGreaterThan(0);

    const rows = [site(1, 'react hooks guide', 'https://react.dev/1')];
    const map = await restProfileMap(rows, RSTAG_GROUPER, { dyn: true });
    expect(map.size).toBe(1);
    expect(map.get(1)!.tags.length).toBeGreaterThan(0);
  });
});
