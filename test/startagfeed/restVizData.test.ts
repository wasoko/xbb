/**
 * restVizData.test.ts — the readings the rest panel draws.
 *
 * Each case builds the reports a pass would return: the kept tags with the
 * channel shares behind them, the burst each row sits in, and the trie hits a
 * keyword reading lists. `Da` rows are structural, so no store is involved —
 * `fake-indexeddb` is here only because importing the grouper module opens the
 * app's own database.
 */

import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import type { Da } from '../../src/sdb';
import type { KeywordMatch, RowTagReport, TagChannelStat, TagExplanation, TagParts } from '../../src/srctag';
import {
  channelShares, keywordHits, priorityCoverage, reportOf, tagClusters, tagTopExplanations, tagsPerTitle,
  themeGroups, vizBlocks,
  VIZ_SMALL_LABEL, VIZ_UNCLUSTERED_LABEL, VIZ_UNSCORED_LABEL, type VizReports,
} from '../../src/ui/restVizData';

/** A row with the fields the list reads. */
const row = (tid: number, txt: string): Da => ({ tid, txt, ref: `https://e.com/${tid}`, type: 'tab', tags: [], rec: {} });

/** One channel's share of a tag's score. */
const channel = (name: keyof TagParts, contribution: number): TagChannelStat =>
  ({ channel: name, weight: 1, value: contribution, contribution });

/** One kept tag, with the channels that carried it. */
const kept = (name: string, ...channels: TagChannelStat[]): TagExplanation =>
  ({ tag: name, score: channels.reduce((n, c) => n + c.contribution, 0), channels, text: '' });

/** One row's report. */
function report(
  tid: number,
  tags: TagExplanation[],
  over: Partial<RowTagReport> = {},
): RowTagReport {
  return {
    tid,
    ref: `https://e.com/${tid}`,
    dim: 'tid',
    window: { lo: 0, hi: 0, radius: 0, indices: [] },
    cluster: 0,
    keywords: [],
    tags,
    ...over,
  };
}

/** A trie hit, as the keyword channel read it. */
const hit = (tag: string, form: string, over: Partial<KeywordMatch> = {}): KeywordMatch =>
  ({ tag, form, start: 0, end: form.length, ...over });

const reports = (...list: RowTagReport[]): VizReports => new Map(list.map((r) => [r.tid!, r]));

describe('tagsPerTitle', () => {
  it('counts the rows per kept-tag count, the untagged bucket included', () => {
    const rows = [row(1, 'a'), row(2, 'b'), row(3, 'c')];
    const map = reports(
      report(1, [kept('react', channel('priority', 1)), kept('hooks', channel('tfidf', 0.5))]),
      report(2, [kept('react', channel('priority', 1))]),
    );
    const head = tagsPerTitle(rows, map);
    expect(head.rows).toBe(3);
    expect(head.scored).toBe(2);
    expect(head.untagged).toBe(1);
    // the third row was never scored, and reads like a row that kept nothing
    expect(head.buckets).toEqual([
      { label: '0', value: 1, share: 0.333 },
      { label: '1', value: 1, share: 0.333 },
      { label: '2', value: 1, share: 0.333 },
    ]);
  });

  it('reads a row with no report as a row that kept nothing', () => {
    expect(reportOf(reports(), row(7, 'x'))).toBeUndefined();
  });
});

describe('priorityCoverage', () => {
  it('splits the rows by the curated tags they kept, and flags those tags', () => {
    const rows = [row(1, 'a'), row(2, 'b'), row(3, 'c'), row(4, 'd')];
    const map = reports(
      report(1, [kept('react', channel('priority', 1)), kept('hooks', channel('tfidf', 0.5))]),
      report(2, [kept('react', channel('priority', 1))]),
      report(3, [kept('hooks', channel('tfidf', 0.5))]),
    );
    const out = priorityCoverage(rows, map);
    expect(out.tagged.map((r) => r.tid)).toEqual([1, 2]);
    expect(out.untagged.map((r) => r.tid)).toEqual([3]);
    expect(out.unscored.map((r) => r.tid)).toEqual([4]);
    expect(out.bars).toEqual([
      { label: 'hooks', value: 2, share: 0.667, priority: false },
      { label: 'react', value: 2, share: 0.667, priority: true },
    ]);
  });
});

describe('tagClusters', () => {
  const rows = [row(1, 'a'), row(2, 'b'), row(3, 'c'), row(4, 'd'), row(5, 'e'), row(6, 'f'), row(7, 'g'), row(8, 'h'), row(9, 'i')];
  const map = reports(
    // row 1 keeps the curated tag second in its own list: the head still comes
    // from the priority half, whatever the row's top tag is
    report(1, [kept('hooks', channel('tfidf', 0.5)), kept('react', channel('priority', 1))]),
    report(2, [kept('react', channel('priority', 1))]),
    // a curated tag is a head however few rows it reaches: the pin card named it
    report(3, [kept('vue', channel('priority', 1))]),
    report(4, [kept('hooks', channel('tfidf', 0.5))]),
    report(5, [kept('hooks', channel('tfidf', 0.5))]),
    report(6, [kept('hooks', channel('tfidf', 0.5))]),
    report(7, [kept('rust', channel('tfidf', 0.5))]),
    report(8, []),
  );

  it('files each row under the tag its priority half carried, curated tags leading', () => {
    const blocks = tagClusters(rows, map);
    expect(blocks.map((b) => [b.tag ?? b.label, b.items.map((r) => r.tid)])).toEqual([
      // the curated tags lead, and among them the wider one first
      ['react', [1, 2]],
      ['vue', [3]],
      ['hooks', [4, 5, 6]],
      // a tag one row keeps is no cluster, so its row trails with its own chips
      [VIZ_SMALL_LABEL, [7]],
      [VIZ_UNCLUSTERED_LABEL, [8]],
      [VIZ_UNSCORED_LABEL, [9]],
    ]);
  });

  it('needs a third row before a tag earns a head', () => {
    const two = [row(1, 'a'), row(2, 'b'), row(3, 'c')];
    const twice = reports(
      report(1, [kept('rust', channel('tfidf', 0.5))]),
      report(2, [kept('rust', channel('tfidf', 0.5))]),
    );
    expect(tagClusters(two, twice).map((b) => b.tag ?? b.label))
      .toEqual([VIZ_SMALL_LABEL, VIZ_UNSCORED_LABEL]);
  });

  it('lists the other tags its rows kept on the head, and marks a minted one', () => {
    /* A curated head reaches whatever rows keep it, so the sub-tag rule is read
       against four rows: three share `quant`/`stress`, the fourth keeps a word of
       its own. */
    const head = [row(1, 'a'), row(2, 'b'), row(3, 'c'), row(4, 'd')];
    const minted = (name: string, strength: number): TagExplanation =>
      ({
        tag: name,
        score: strength,
        channels: [{ channel: 'group', weight: 0.5, value: strength, contribution: strength }],
        text: '',
        origin: 'sub',
      });
    const map = reports(
      // row 1 carries the word and the minted theme at once: the label counts once
      report(1, [kept('risk', channel('priority', 1)), kept('quant', channel('bm25', 0.4)), minted('risk/quant', 2), kept('stress', channel('bm25', 0.3))]),
      report(2, [kept('risk', channel('priority', 1)), kept('quant', channel('bm25', 0.4))]),
      // the minted `risk/quant` names a theme the same cluster already kept as a word
      report(3, [kept('risk', channel('priority', 1)), kept('stress', channel('bm25', 0.3)), minted('risk/quant', 2)]),
      report(4, [kept('risk', channel('priority', 1)), kept('outlier', channel('bm25', 0.2))]),
    );

    const block = tagClusters(head, map)[0];
    expect(block.tag).toBe('risk');
    expect(block.items.map((r) => r.tid)).toEqual([1, 2, 3, 4]);
    expect(block.subs).toEqual([
      // counted once however a row carried it, and the minted tag is what marks it:
      // rows 1-2 kept `quant`, row 3 carried it as the theme aim minted for the burst
      { tag: 'quant', rows: 3, sub: true },
      { tag: 'stress', rows: 2 },
    ]);
  });

  it('lists every row of the list exactly once, and in its own order inside a block', () => {
    const blocks = tagClusters(rows, map);
    const items = blocks.flatMap((b) => b.items);
    expect(items).toHaveLength(rows.length);
    expect(new Set(items.map((r) => r.tid))).toEqual(new Set([1, 2, 3, 4, 5, 6, 7, 8, 9]));
    expect(blocks[2].items.map((r) => r.tid)).toEqual([4, 5, 6]);
  });
});

describe('tagTopExplanations', () => {
  it('keeps the highest-scored explanation of a tag with the report that carried it', () => {
    const rows = [row(1, 'a'), row(2, 'b')];
    const map = reports(
      report(1, [kept('react', channel('priority', 0.2))]),
      report(2, [kept('react', channel('priority', 0.9))], { dim: 'visitTime' }),
    );
    const details = tagTopExplanations(rows, map);
    expect(details.get('react')!.explanation.score).toBe(0.9);
    expect(details.get('react')!.report.dim).toBe('visitTime');
    // the rows the pass never scored contribute nothing
    expect(tagTopExplanations([row(9, 'z')], map).size).toBe(0);
  });
});

describe('themeGroups', () => {
  const rows = [row(1, 'a'), row(2, 'b'), row(3, 'c'), row(4, 'd')];
  const map = reports(
    report(1, [kept('react', channel('priority', 1)), kept('hooks', channel('tfidf', 0.5))]),
    report(2, [kept('react', channel('priority', 1)), kept('hooks', channel('tfidf', 0.5))]),
    report(3, [kept('react', channel('priority', 1)), kept('hooks', channel('tfidf', 0.5))], { cluster: 1 }),
    report(4, [kept('vue', channel('priority', 1))], { cluster: 1 }),
  );

  it('names the terms a burst-and-anchor group shares', () => {
    const { groups } = themeGroups(rows, map, 2);
    const first = groups.find((g) => g.cluster === 0)!;
    expect(first.anchor).toBe('react');
    expect(first.items.map((r) => r.tid)).toEqual([1, 2]);
    // the anchor is the group's own tag, not one of its themes
    expect(first.shared.map((s) => s.label)).toEqual(['hooks']);
    // the default threshold is three rows, and the second burst holds `hooks` once
    expect(themeGroups(rows, map).groups.find((g) => g.cluster === 1)!.shared).toEqual([]);
  });

  it('moves the threshold with minShared, and lists the rows the cap left out', () => {
    const { groups, unscored } = themeGroups([...rows, row(9, 'e')], map, 1);
    expect(groups.find((g) => g.cluster === 1)!.shared.map((s) => s.label)).toEqual(['hooks']);
    expect(unscored.map((r) => r.tid)).toEqual([9]);
  });
});

describe('channelShares', () => {
  it('takes each channel share from the explanations the pass returned', () => {
    const map = reports(
      report(1, [
        kept('react', channel('priority', 0.2), channel('keyword', 0.3)),
        kept('hooks', channel('tfidf', 0.5)),
      ]),
    );
    expect(channelShares(map)).toEqual([
      { label: 'tfidf', value: 0.5, share: 0.5 },
      { label: 'turbotext', value: 0.3, share: 0.3 },
      { label: 'priority', value: 0.2, share: 0.2 },
    ]);
  });

  it('reports nothing for a pass that scored nothing', () => {
    expect(channelShares(reports())).toEqual([]);
  });
});

describe('keywordHits', () => {
  it('counts the rows behind each surface form and keeps example titles', () => {
    const rows = [row(1, 'React hooks guide'), row(2, 'React hooks state'), row(3, 'vue docs')];
    const map = reports(
      report(1, [kept('react', channel('keyword', 1))], { keywords: [hit('react', 'React'), hit('react hooks', 'React hooks')] }),
      report(2, [kept('react', channel('keyword', 1))], { keywords: [hit('react', 'React')] }),
      report(3, [], { keywords: [hit('vue', 'vue'), hit('vue', 'in vue', { block: true })] }),
    );
    const hits = keywordHits(rows, map);
    expect(hits.map((h) => [h.form, h.tag, h.rows])).toEqual([
      ['React', 'react', 2],
      ['React hooks', 'react hooks', 1],
      ['vue', 'vue', 1],
    ]);
    expect(hits[0].titles).toEqual(['React hooks guide', 'React hooks state']);
    // a suppressing entry never reaches the reading
    expect(hits.some((h) => h.form === 'in vue')).toBe(false);
  });

  it('counts a form once per row however often it occurs', () => {
    const map = reports(report(1, [], { keywords: [hit('react', 'react'), hit('react', 'react')] }));
    expect(keywordHits([row(1, 'react react')], map)).toEqual([
      { form: 'react', tag: 'react', rows: 1, titles: ['react react'] },
    ]);
  });
});

describe('vizBlocks', () => {
  const rows = [row(1, 'a'), row(2, 'b'), row(3, 'c'), row(4, 'd')];
  const map = reports(
    report(1, [kept('react', channel('priority', 1))]),
    report(2, [kept('hooks', channel('tfidf', 0.5))]),
    report(3, [kept('react', channel('priority', 1)), kept('hooks', channel('tfidf', 0.5))], { cluster: 1 }),
  );

  it('keeps the existing blocks for every reading that is not a partition', () => {
    for (const mode of ['chips', 'channels', 'keywords'] as const) {
      expect(vizBlocks(mode, rows, map)).toBeUndefined();
    }
  });

  it('partitions the clustered reading by the tag each row is filed under', () => {
    const blocks = vizBlocks('clusters', rows, map)!;
    expect(blocks.map((b) => [b.tag ?? b.label, b.items.map((r) => r.tid)])).toEqual([
      ['react', [1, 3]],
      // `hooks` is kept by one row and no pin card named it, so it is no head
      [VIZ_SMALL_LABEL, [2]],
      [VIZ_UNSCORED_LABEL, [4]],
    ]);
  });

  it('partitions the priority reading so every row appears exactly once', () => {
    const blocks = vizBlocks('priority', rows, map)!;
    expect(blocks.map((b) => [b.label, b.items.map((r) => r.tid)])).toEqual([
      ['priority tag kept', [1, 3]],
      ['no tag kept', [2]],
      [VIZ_UNSCORED_LABEL, [4]],
    ]);
    expect(blocks.flatMap((b) => b.items).map((r) => r.tid)).toEqual([1, 3, 2, 4]);
  });

  it('partitions the theme reading by burst and anchor', () => {
    const blocks = vizBlocks('themes', rows, map)!;
    expect(blocks.map((b) => b.items.map((r) => r.tid))).toEqual([[1], [2], [3], [4]]);
    expect(blocks[0].label).toContain('react');
    expect(blocks[3].label).toBe(VIZ_UNSCORED_LABEL);
  });
});
