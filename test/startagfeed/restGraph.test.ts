/**
 * @vitest-environment happy-dom
 *
 * restGraph.test.ts — the tag graph the rest list's wide view reads itself with.
 *
 * The graph is built from evidence the pass already produced, so the tests check the
 * three things that decide the reading: which tags are nodes and what each one is,
 * what an edge's weight means, and what the per-node lexical share averages over.
 * The layout is a pure function of that graph, so it is tested on its own.
 */

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { type RowTagReport, type TagExplanation } from '../../src/srctag';
import type { Da } from '../../src/sdb';
import { RestGraph } from '../../src/ui/RestGraph';
import {
  GRAPH_NODE_KIND, GRAPH_REACH, REACH_RING, buildTagGraph, headingTags, pinReach, tagGraphLayout,
} from '../../src/ui/restGraph';

const row = (tid: number, tags: string[] = []): Da =>
  ({ tid, ref: `https://example.com/${tid}`, type: 'tab', txt: `row ${tid}`, tags, rec: {} });

/** A pin md card whose `#tag` headings are the curated half. */
const pin = (headings: string[]): Da =>
  ({ tid: -1, ref: 'pin/demo.md', type: 'md', txt: headings.map((h) => `## x #${h}`).join('\n'), tags: [], rec: {} });

const tag = (t: string, over: Partial<TagExplanation> = {}): TagExplanation =>
  ({ tag: t, score: 1, channels: [], text: '', ...over });

const report = (tid: number, tags: TagExplanation[], qarf?: number): RowTagReport => ({
  tid,
  ref: `https://example.com/${tid}`,
  dim: 'tid',
  window: { lo: 0, hi: 0, radius: 0, indices: [] },
  cluster: 0,
  keywords: [],
  tags,
  ...(qarf === undefined ? {} : { qarf }),
});

const reportsOf = (...rs: RowTagReport[]) => new Map(rs.map((r) => [r.tid!, r]));

describe('headingTags', () => {
  it('drops the board marker, the tombstone and the capture provenance', () => {
    expect(headingTags(row(1, ['pin', '[del]', 'dev_saOpera', 'suffix_GoogleSearch', 'react'])))
      .toEqual(['react']);
  });
});

describe('buildTagGraph', () => {
  it('roots the graph at the pin cards and files each node under what it is', () => {
    const pins = [pin(['react'])];
    const rows = [row(1), row(2), row(3)];
    const reports = reportsOf(
      report(1, [tag('react'), tag('hooks'), tag('react/hooks', { origin: 'sub' })]),
      /* `hooks` heads this row, which is what makes it a head rather than a chip. */
      report(2, [tag('hooks'), tag('react')]),
      report(3, [tag('vue'), tag('composition')]),
    );
    const graph = buildTagGraph(pins, rows, reports);

    expect([...graph.roots]).toEqual(['react']);
    expect(graph.kind.get('react')).toBe('pinned');
    expect(graph.kind.get('hooks')).toBe('head');
    // a promoted sub-tag is a theme, and its anchor is the head it refines
    expect(graph.kind.get('react/hooks')).toBe('theme');
    expect(graph.anchor.get('react/hooks')).toBe('react');
    expect(graph.kind.get('composition')).toBe('own');
    // the rows the pass kept each tag for
    expect(graph.weight.get('react')).toBe(2);
    expect(graph.weight.get('hooks')).toBe(2);
    expect(graph.weight.get('composition')).toBe(1);
    // two tags one row holds are adjacent, by that co-occurrence
    expect(graph.edges.get('hooks')?.get('react')).toBe(2);
    expect(graph.edges.get('composition')?.get('vue')).toBe(1);
  });

  it('averages the lexical share over the rows that kept each tag', () => {
    const pins = [pin(['react'])];
    const rows = [row(1), row(2)];
    const reports = reportsOf(
      report(1, [tag('react'), tag('hooks')], 0.8),
      report(2, [tag('react'), tag('hooks')], 0.4),
    );
    const graph = buildTagGraph(pins, rows, reports);
    expect(graph.lambda.get('hooks')).toBeCloseTo(0.6, 12);
    expect(graph.lambda.get('react')).toBeCloseTo(0.6, 12);
  });

  it('carries no share at all on a fixed-weighting pass', () => {
    const graph = buildTagGraph([pin(['react'])], [row(1)], reportsOf(report(1, [tag('react')])));
    expect(graph.lambda.size).toBe(0);
  });

  it('counts a tag the rows are filed under even when the pass kept nothing', () => {
    const graph = buildTagGraph([pin(['react'])], [row(1, ['react']), row(2, ['react'])], reportsOf());
    expect(graph.weight.get('react')).toBe(2);
    expect(graph.kind.get('react')).toBe('pinned');
  });

  it('merges variants of one tag into a single node', () => {
    const graph = buildTagGraph([],
      [row(1), row(2)],
      reportsOf(report(1, [tag('DeepSeek')]), report(2, [tag('deepseek')])));
    expect(graph.weight.size).toBe(1);
    expect(graph.weight.get('DeepSeek')).toBe(2);
  });

  it('holds no node for a pass that kept nothing and rows that carry nothing', () => {
    const graph = buildTagGraph([], [row(1)], reportsOf(report(1, [])));
    expect(graph.weight.size).toBe(0);
    expect(tagGraphLayout(graph).nodes).toEqual([]);
  });
});

describe('tagGraphLayout', () => {
  const graphWith = () => buildTagGraph([pin(['react'])], [row(1), row(2), row(3)], reportsOf(
    report(1, [tag('react'), tag('hooks'), tag('react/hooks', { origin: 'sub' })]),
    report(2, [tag('hooks'), tag('react')]),
    report(3, [tag('react')]),
  ));

  it('puts a pinned tag at the centre and a chip no head claims on the outer ring', () => {
    const { nodes } = tagGraphLayout(graphWith());
    const at = (t: string) => nodes.find((n) => n.tag === t)!;
    expect(at('react').kind).toBe('pinned');
    expect(Math.hypot(at('react').x, at('react').y)).toBeCloseTo(0, 12);
    // a head sits between the centre and the outer ring, and the theme outside it
    expect(Math.hypot(at('hooks').x, at('hooks').y))
      .toBeGreaterThan(Math.hypot(at('react').x, at('react').y));
    expect(Math.hypot(at('react/hooks').x, at('react/hooks').y))
      .toBeGreaterThan(Math.hypot(at('hooks').x, at('hooks').y));
    for (const n of nodes) expect(Math.hypot(n.x, n.y)).toBeLessThanOrEqual(1 + 1e-9);
  });

  it('scales a node by the rows that kept it', () => {
    const { nodes } = tagGraphLayout(graphWith());
    const at = (t: string) => nodes.find((n) => n.tag === t)!;
    expect(at('react').rows).toBeGreaterThan(at('hooks').rows);
    expect(at('react').r).toBeGreaterThan(at('hooks').r);
  });

  it('lists each edge once, and carries the share a node was read with', () => {
    const graph = buildTagGraph([pin(['react'])], [row(1), row(2)], reportsOf(
      report(1, [tag('react'), tag('hooks')], 0.8),
      report(2, [tag('react'), tag('hooks')], 0.6),
    ));
    const layout = tagGraphLayout(graph);
    expect(layout.edges).toHaveLength(1);
    expect(layout.edges[0]).toMatchObject({ a: 'hooks', b: 'react', w: 2 });
    expect(layout.edges[0].w).toBeLessThanOrEqual(layout.maxEdge);
    expect(layout.nodes.find((n) => n.tag === 'hooks')!.lambda).toBeCloseTo(0.7, 12);
  });

  it('names every kind it can place, so a legend can explain a node', () => {
    for (const n of tagGraphLayout(graphWith()).nodes) {
      expect(GRAPH_NODE_KIND[n.kind].label).toBeTruthy();
      expect(GRAPH_NODE_KIND[n.kind].help).toBeTruthy();
    }
  });

  it('is deterministic: the same graph lays out the same way', () => {
    const a = tagGraphLayout(graphWith());
    const b = tagGraphLayout(graphWith());
    expect(b.nodes.map((n) => [n.tag, n.x, n.y])).toEqual(a.nodes.map((n) => [n.tag, n.x, n.y]));
  });
});

describe('pinReach', () => {
  /* A seed that reaches every band: a pin, a respelling of it, a tag beside the pin, a
     tag two steps out, and a pair nothing reaches. */
  const seed = () => {
    const rows = [row(1), row(2), row(3), row(4)];
    const reports = reportsOf(
      report(1, [tag('react'), tag('hooks')]),
      report(2, [tag('React'), tag('hooks')]),
      report(3, [tag('hooks'), tag('state')]),
      report(4, [tag('vue'), tag('composition')]),
    );
    return buildTagGraph([pin(['react'])], rows, reports, { keepAliases: true });
  };

  it('bands every node by how far it is from a pinned heading', () => {
    const reach = pinReach(seed());
    expect(reach.get('react')).toBe('pinned');
    expect(reach.get('React')).toBe('alias');
    expect(reach.get('hooks')).toBe('related');
    expect(reach.get('state')).toBe('remote');
    expect(reach.get('vue')).toBe('own');
    expect(reach.get('composition')).toBe('own');
  });

  it('partitions the nodes, so a band never has to be guessed at', () => {
    const graph = seed();
    const reach = pinReach(graph);
    expect(reach.size).toBe(graph.weight.size);
    for (const tag of graph.weight.keys()) expect(GRAPH_REACH[reach.get(tag)!]).toBeDefined();
  });

  it('keeps a pin\'s respelling as its own node only when asked', () => {
    const kept = seed();
    expect(kept.alias.get('React')).toBe('react');
    expect(kept.weight.has('React')).toBe(true);

    const folded = buildTagGraph([pin(['react'])], [row(1), row(2)], reportsOf(
      report(1, [tag('react')]),
      report(2, [tag('React')]),
    ));
    expect(folded.alias.size).toBe(0);
    expect(folded.weight.has('React')).toBe(false);
    // the respelling's row is still counted, on the node it folded into
    expect(folded.weight.get('react')).toBe(2);
  });

  it('lays the bands out on the rings the caller names', () => {
    const graph = seed();
    const reach = pinReach(graph);
    const layout = tagGraphLayout(graph, { kind: (t) => reach.get(t) ?? 'own', ring: REACH_RING });
    const at = (t: string) => layout.nodes.find((n) => n.tag === t)!;
    expect(at('react').kind).toBe('pinned');
    expect(Math.hypot(at('react').x, at('react').y)).toBeCloseTo(0, 12);
    expect(at('React').kind).toBe('alias');
    expect(Math.hypot(at('React').x, at('React').y)).toBeCloseTo(REACH_RING.alias, 12);
    expect(Math.hypot(at('hooks').x, at('hooks').y)).toBeCloseTo(REACH_RING.related, 12);
    expect(Math.hypot(at('vue').x, at('vue').y)).toBeCloseTo(REACH_RING.own, 12);
  });

  it('draws the pin reading when the renderer is given its vocabulary', () => {
    const graph = seed();
    const reach = pinReach(graph);
    const drawn = renderToStaticMarkup(React.createElement(RestGraph, {
      graph,
      kinds: GRAPH_REACH,
      layout: { kind: (t: string) => reach.get(t) ?? 'own', ring: REACH_RING },
    }));
    expect(drawn).toContain('pin alias');
    expect(drawn).toContain('own cluster');
  });
});

describe('RestGraph', () => {
  it('draws one circle per node and each edge once', () => {
    const graph = buildTagGraph([pin(['react'])], [row(1), row(2)], reportsOf(
      report(1, [tag('react'), tag('hooks')], 0.8),
      report(2, [tag('hooks'), tag('react')], 0.6),
    ));
    const drawn = renderToStaticMarkup(React.createElement(RestGraph, { graph }));
    expect(drawn.match(/<circle/g)).toHaveLength(2);
    expect(drawn.match(/<line/g)).toHaveLength(1);
    // the outline is the mean share, warm at the lexical end
    expect(drawn).toContain('rgb(232, 168, 76) 75%');
  });

  it('says so when the pass kept nothing to draw', () => {
    const empty = buildTagGraph([], [], reportsOf());
    expect(renderToStaticMarkup(React.createElement(RestGraph, { graph: empty })))
      .toContain('no graph nodes');
  });

  it('falls back to the tag\'s own hue when the pass was not adaptive', () => {
    const graph = buildTagGraph([pin(['react'])], [row(1)], reportsOf(report(1, [tag('react')])));
    const drawn = renderToStaticMarkup(React.createElement(RestGraph, { graph }));
    expect(drawn).not.toContain('232, 168, 76');
  });
});
