/**
 * seaTrend.test.ts — the recent head read against the older tail.
 *
 * The pass is pure, so these tests give it rows with visit times and sync stamps and
 * assert which tags it calls emerging, how it orders them, and which neighbours the
 * wall's recent band is allowed to draw.
 */

import { describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import type { Da } from '../../src/sdb';
import type { RowTagReport, TagExplanation } from '../../src/srctag';
import { graphFromTags, type SeaRelations, type SeaTag } from '../../src/ui/seaTags';
import { emergingTags, recentStamp, tagTrends } from '../../src/ui/seaTrend';

const NO_RELATIONS: SeaRelations = {
  web: [], themes: [], bursts: [], aliases: [], synonyms: [],
};

const TAGS: SeaTag[] = [
  { tag: 'pin', reach: 'pinned', kind: 'pinned', score: 1, weight: 10, freq: 10 },
  { tag: 'fresh', reach: 'own', kind: 'own', score: 1, weight: 4, freq: 4 },
  { tag: 'stale', reach: 'own', kind: 'own', score: 1, weight: 4, freq: 4 },
  { tag: 'neighbour', reach: 'related', kind: 'own', score: 1, weight: 3, freq: 3 },
];
const GRAPH = graphFromTags(TAGS, NO_RELATIONS);

const row = (
  tid: number, tags: string[], dt: Date, visit?: number,
): Da => ({
  tid, ref: `https://example.com/${tid}`, type: 'tab', txt: `row ${tid}`,
  tags, dt, rec: visit === undefined ? {} : { visitTime: visit },
});

const tagged = (tag: string): TagExplanation =>
  ({ tag, score: 1, channels: [], text: '', top: 'bm25' });

const report = (tid: number, tags: string[]): RowTagReport => ({
  tid, ref: `https://example.com/${tid}`, dim: 'visitTime',
  window: { lo: 0, hi: 0, radius: 0, indices: [] },
  cluster: 0, keywords: [], tags: tags.map(tagged),
});

const reports = (entries: [number, string[]][]): Map<number, RowTagReport> =>
  new Map(entries.map(([tid, tags]) => [tid, report(tid, tags)]));

describe('recentStamp', () => {
  it('prefers the browser visit time over the sync stamp', () => {
    expect(recentStamp(row(1, [], new Date('2026-01-01'), 1_800_000_000_000)))
      .toBe(1_800_000_000_000);
  });

  it('falls back to the later of dt and modAt', () => {
    const at = new Date('2026-02-01').getTime();
    const later = new Date('2026-03-01').getTime();
    expect(recentStamp({
      tid: 1, ref: 'x', type: 'tab', txt: 'x', dt: new Date(at),
      modAt: new Date(later), rec: {},
    })).toBe(later);
  });
});

describe('tagTrends', () => {
  const rows = [
    row(1, ['fresh'], new Date('2026-01-01'), 400),
    row(2, ['pin'], new Date('2026-01-02'), 300),
    row(3, ['stale'], new Date('2026-01-03'), 200),
    row(4, ['stale'], new Date('2026-01-04'), 100),
  ];
  const trend = tagTrends(rows, reports([[1, ['fresh', 'fresh']], [2, ['pin']], [3, ['stale']], [4, ['stale']]]), GRAPH, {
    recent: 2, minRecent: 1, minLift: 2,
  });

  it('marks a tag kept by the recent head and not the tail', () => {
    expect(trend.get('fresh')).toMatchObject({
      recent: 1, base: 0, emerging: true,
    });
    expect(trend.get('fresh')!.score).toBeGreaterThan(0);
  });

  it('does not mark a tag whose support stays in the older tail', () => {
    expect(trend.get('stale')).toMatchObject({
      recent: 0, base: 2, emerging: false,
    });
  });

  it('counts rows, not repeated tags on one row', () => {
    expect(trend.get('fresh')!.recent).toBe(1);
  });

  it('orders the wall recent band by trend score and keeps pinned tags out', () => {
    const emerging = emergingTags(GRAPH, trend, { maxEmerging: 4, maxChildren: 4 });
    expect(emerging.map((entry) => entry.tag)).not.toContain('pin');
    expect(emerging[0].tag).toBe('fresh');
  });
});

describe('the recent band children', () => {
  it('draws one-hop neighbours and no second hop', () => {
    const rows = [
      row(1, ['fresh'], new Date('2026-01-01'), 400),
      row(2, ['neighbour'], new Date('2026-01-02'), 300),
    ];
    const graph = graphFromTags(TAGS, {
      ...NO_RELATIONS,
      web: [
        { a: 'fresh', b: 'neighbour', w: 2 },
        { a: 'neighbour', b: 'stale', w: 1 },
      ],
    });
    const trend = tagTrends(rows, reports([[1, ['fresh']], [2, ['neighbour']]]), graph, {
      recent: 1, minRecent: 1, minLift: 0,
    });
    const emerging = emergingTags(graph, trend, { maxEmerging: 2, maxChildren: 4 });
    const fresh = emerging.find((entry) => entry.tag === 'fresh');
    expect(fresh?.children).toEqual(['neighbour']);
  });
});
