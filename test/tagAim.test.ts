/**
 * tagAim.test.ts — the two rules the tag groupers apply by default: focus and
 * promote.
 *
 * The cases are built from `TagRowResult` values rather than from `tagRows`, so
 * each one states the evidence it is about: a suggestion's channel breakdown,
 * the burst its row sits in, and the tags the row already carries.
 */

import { describe, expect, it } from 'vitest';
import {
  applyTagAim, DEFAULT_TAG_AIM, explainTag, summarizeTagAim, tagRowReports,
  type TagParts, type TagRow, type TagRowResult, type TagSuggestion,
} from '../src/srctag';

/** A channel breakdown with only what a case sets. */
function parts(over: Partial<TagParts> = {}): TagParts {
  return {
    tfidf: 0, embed: 0, textRank: 0, clusterRank: 0, priority: 0, keyword: 0, suggest: 0,
    group: 0, ...over,
  };
}

/** One scored candidate. */
const sug = (tag: string, score: number, over: Partial<TagParts> = {}): TagSuggestion =>
  ({ tag, score, parts: parts(over) });

/** A row with the fields a tab row carries. */
const row = (tid: number, txt: string, over: Partial<TagRow> = {}): TagRow =>
  ({ tid, txt, ref: `https://example.com/${tid}`, type: 'tab', tags: [], rec: {}, ...over });

/** One scored row: only the fields an aim case reads are required. */
function result(
  over: Partial<TagRowResult> & { row: TagRow; suggestions: TagSuggestion[] },
): TagRowResult {
  return {
    window: { lo: 0, hi: 0, radius: 0, indices: [] },
    dim: 'tid',
    cluster: 0,
    keywords: [],
    ...over,
  };
}

/**
 * `n` rows of one burst, all keeping `anchor` and proposing `theme`; an empty
 * `theme` leaves each row with the anchor alone.
 */
const burst = (n: number, anchor: string, theme: string, cluster = 0): TagRowResult[] =>
  Array.from({ length: n }, (_, i) => result({
    row: row(i + 1, `${anchor} ${theme} ${i}`),
    cluster,
    suggestions: theme
      ? [sug(anchor, 0.9, { priority: 1 }), sug(theme, 0.5)]
      : [sug(anchor, 0.9, { priority: 1 })],
  }));

describe('focus', () => {
  it('keeps what the priority half carried and what clears aimMin, and drops the rest', () => {
    const [out] = applyTagAim([result({
      row: row(1, 'react hooks guide'),
      suggestions: [sug('react', 0.9, { priority: 1 }), sug('hooks', 0.5), sug('guide', 0.2)],
    })]);
    expect(out.suggestions.map((s) => s.tag)).toEqual(['react', 'hooks']);
  });

  it('keeps a tag the aim config names as a priority whatever it scored', () => {
    const [out] = applyTagAim([result({
      row: row(1, 'vue guide'),
      suggestions: [sug('vue', 0.05), sug('guide', 0.2)],
    })], { priorityTags: ['vue'] });
    expect(out.suggestions.map((s) => s.tag)).toEqual(['vue']);
  });

  it('never lets aimMin fall below the fusion cut-off', () => {
    const rows = [result({
      row: row(1, 'react hooks guide'),
      suggestions: [sug('hooks', 0.5), sug('guide', 0.9)],
    })];
    // an aimMin under the run's 0.6 is raised to it, so only the 0.9 survives
    const [out] = applyTagAim(rows, { aimMin: 0.1 }, 0.6);
    expect(out.suggestions.map((s) => s.tag)).toEqual(['guide']);
  });

  it('leaves the input results untouched', () => {
    const input = result({
      row: row(1, 'react hooks guide'),
      suggestions: [sug('react', 0.9, { priority: 1 }), sug('guide', 0.2)],
    });
    applyTagAim([input]);
    expect(input.suggestions.map((s) => s.tag)).toEqual(['react', 'guide']);
  });
});

describe('promote', () => {
  it('mints a parent/theme sub-tag for a term more than two rows of one burst share', () => {
    const out = applyTagAim(burst(3, 'react', 'hooks'));
    for (const r of out) {
      expect(r.suggestions.map((s) => s.tag)).toEqual(['react', 'hooks', 'react/hooks']);
      expect(r.suggestions[2].parts.group).toBe(3);
      expect(r.suggestions[2].score).toBe(3);
    }
  });

  it('promotes nothing when only two rows of the burst share the term', () => {
    const out = applyTagAim(burst(2, 'react', 'hooks'));
    expect(out[0].suggestions.map((s) => s.tag)).toEqual(['react', 'hooks']);
  });

  it('does not promote a term two different bursts each hold', () => {
    const out = applyTagAim([...burst(2, 'react', 'hooks', 0), ...burst(2, 'react', 'hooks', 1)]);
    for (const r of out) expect(r.suggestions.map((s) => s.tag)).toEqual(['react', 'hooks']);
  });

  it('needs the same anchor, not merely the same burst', () => {
    const out = applyTagAim([...burst(2, 'react', 'hooks'), ...burst(1, 'vue', 'hooks')]);
    for (const r of out) expect(r.suggestions.map((s) => s.tag)).not.toContain('react/hooks');
  });

  it('counts the pre-focus lists, so focus cannot erase its own theme signal', () => {
    /* every row drops its only suggestion, and the term they shared still becomes
       the bare theme of the untagged group */
    const rows = Array.from({ length: 3 }, (_, i) => result({
      row: row(i + 1, `hooks ${i}`),
      suggestions: [sug('hooks', 0.2)],
    }));
    const out = applyTagAim(rows);
    for (const r of out) {
      expect(r.suggestions.map((s) => s.tag)).toEqual(['hooks']);
      expect(r.suggestions[0].parts.group).toBe(3);
    }
  });

  it('skips a sub-tag the row already carries, and the anchor it repeats', () => {
    const rows = burst(3, 'react', 'hooks');
    rows[0].row.tags = ['react/hooks'];
    const out = applyTagAim(rows);
    expect(out[0].suggestions.map((s) => s.tag)).toEqual(['react', 'hooks']);
    expect(out[1].suggestions.map((s) => s.tag)).toEqual(['react', 'hooks', 'react/hooks']);
    // the anchor is already kept, so it is never minted as `react/react`
    expect(out[1].suggestions.some((s) => s.tag === 'react/react')).toBe(false);
  });

  it('mints only the group’s most widespread themes, ties broken by name', () => {
    const rows = Array.from({ length: 4 }, (_, i) => result({
      row: row(i + 1, `react theme ${i}`),
      suggestions: [sug('react', 0.9, { priority: 1 }), sug('hooks', 0.5)],
    }));
    for (const i of [0, 1, 2]) {
      rows[i].suggestions.push(sug('state', 0.45), sug('guide', 0.45));
    }
    const capped = applyTagAim(rows);
    expect(capped[0].suggestions.map((s) => s.tag))
      .toEqual(['react', 'hooks', 'state', 'guide', 'react/hooks', 'react/guide']);
    // `state` and `guide` tie at three rows, and the cap keeps the first by name
    expect(applyTagAim(rows, { promoteTop: Infinity })[0].suggestions.map((s) => s.tag))
      .toEqual(['react', 'hooks', 'state', 'guide', 'react/hooks', 'react/guide', 'react/state']);
  });

  it('honours a custom promote threshold and separator', () => {
    const out = applyTagAim(burst(2, 'react', 'hooks'), { promoteMin: 2, sep: ':' });
    expect(out[0].suggestions.map((s) => s.tag)).toEqual(['react', 'hooks', 'react:hooks']);
  });

  it('can be turned off, leaving the focused lists alone', () => {
    const out = applyTagAim(burst(3, 'react', 'hooks'), { promote: false });
    expect(out[0].suggestions.map((s) => s.tag)).toEqual(['react', 'hooks']);
  });
});

describe('sub-tag explanations', () => {
  it('report the group size as the whole score, through the theme channel', () => {
    const out = applyTagAim(burst(3, 'react', 'hooks'));
    const sub = out[0].suggestions.find((s) => s.tag === 'react/hooks')!;
    const explained = explainTag(sub);
    expect(explained.origin).toBe('sub');
    expect(explained.channels).toEqual([
      { channel: 'group', weight: 1, value: 3, contribution: 3 },
    ]);
    expect(explained.text).toBe('theme 3.00×1.00=3.00');
    expect(explained.score).toBe(3);
  });
});

describe('summarizeTagAim', () => {
  it('folds a pass into its row, untagged, histogram, priority, and sub-tag numbers', () => {
    const aimed = applyTagAim([
      ...Array.from({ length: 3 }, (_, i) => result({
        row: row(i + 1, `react hooks ${i}`),
        suggestions: [sug('react', 0.9, { priority: 1 }), sug('hooks', 0.5)],
      })),
      result({ row: row(9, 'nothing here'), suggestions: [sug('here', 0.2)] }),
    ]);
    const stats = summarizeTagAim(aimed);
    expect(stats.rows).toBe(4);
    expect(stats.untagged).toBe(1);
    expect(stats.priority).toBe(3);
    expect(stats.histogram).toEqual([{ tags: 0, rows: 1 }, { tags: 3, rows: 3 }]);
    expect(stats.subTags).toEqual([{ tag: 'react/hooks', rows: 3, group: 3 }]);
  });

  it('defaults the promote threshold to more than two rows', () => {
    expect(DEFAULT_TAG_AIM.promoteMin).toBe(3);
    expect(DEFAULT_TAG_AIM.sep).toBe('/');
  });
});

describe('tagRowReports', () => {
  /* The URLs are off, the way the algorithm groupers read a row: a hostname
     label is not evidence about what the tab is. */
  const rows = [
    row(1, 'react hooks guide'),
    row(2, 'react hooks state'),
    row(3, 'react hooks docs'),
  ];
  const opts = {
    priorityTags: ['react'],
    urls: false,
    score: { tfidf: 0.35, embed: 0, textRank: 0, clusterRank: 0, priority: 0.2, suggest: 0 },
  };

  it('leaves the raw scores alone unless the caller asks for aim', async () => {
    const raw = await tagRowReports(rows, opts);
    expect(raw[0].tags.length).toBeGreaterThan(1);
  });

  it('focuses every row onto the tags the priority half carried', async () => {
    const aimed = await tagRowReports(rows, { ...opts, aim: { promote: false } });
    for (const report of aimed) expect(report.tags.map((t) => t.tag)).toEqual(['react']);
  });

  it('promotes a term three rows of one burst share', async () => {
    const aimed = await tagRowReports(rows, { ...opts, aim: { promote: true } });
    expect(aimed[0].tags.map((t) => t.tag)).toEqual(['react', 'react/hooks']);
    expect(aimed[0].tags[1].origin).toBe('sub');
  });

  it('carries the trie hits a keyword reading lists', async () => {
    const raw = await tagRowReports(rows, opts);
    expect(raw[0].keywords.length).toBeGreaterThan(0);
    expect(raw[0].keywords[0].tag).toBe('react');
  });
});
