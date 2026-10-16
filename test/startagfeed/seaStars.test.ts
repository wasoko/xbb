/**
 * seaStars.test.ts — the marks a wall of regions is drawn with.
 *
 * `seaRegion` owns the packing and `restGraph` owns the evidence; this module owns the two
 * things a renderer needs on top of them: one star per region at the region's own middle,
 * and the edges one row's chip list made. The tests check that the stars follow the packing
 * rather than a placement of their own, that an edge is drawn once and heaviest first, that
 * the scales are the widest tag and the heaviest edge, and that the legend names every kind
 * the reading has, including the ones it placed nothing on.
 */

import { describe, expect, it } from 'vitest';
import { GRAPH_REACH, type GraphNodeKind, type TagGraph } from '../../src/ui/restGraph';
import { seaRegions, type SeaRegion } from '../../src/ui/seaRegion';
import {
  kindOf, seaStars, skyLegend, starOpacity, starSize,
} from '../../src/ui/seaStars';

/** One node of the fixture graph. */
interface Node {
  tag: string;
  kind: GraphNodeKind;
  rows: number;
  lambda?: number;
}

/**
 * A graph as `restGraph.buildTagGraph` returns one, over the nodes given.
 *
 * @param nodes the tags, with their kind and how many rows kept them
 * @param pairs edges as `[a, b, weight]`
 * @returns the graph
 */
function graphOf(nodes: Node[], pairs: [string, string, number][] = []): TagGraph {
  const edges = new Map(nodes.map((n) => [n.tag, new Map<string, number>()]));
  for (const [a, b, w] of pairs) {
    const na = edges.get(a);
    const nb = edges.get(b);
    if (!na || !nb) continue;
    na.set(b, w);
    nb.set(a, w);
  }
  return {
    roots: new Set(nodes.filter((n) => n.kind === 'pinned').map((n) => n.tag)),
    edges,
    weight: new Map(nodes.map((n) => [n.tag, n.rows])),
    name: (tag) => tag,
    kind: new Map(nodes.map((n) => [n.tag, n.kind])),
    anchor: new Map(),
    alias: new Map(),
    lambda: new Map(nodes.filter((n) => n.lambda !== undefined).map((n) => [n.tag, n.lambda!])),
  };
}

/** A small reading: one pin, three tags beside it and one no pin reaches. */
const FIXTURE = graphOf([
  { tag: 'pin', kind: 'pinned', rows: 12, lambda: 0.7 },
  { tag: 'near', kind: 'own', rows: 30 },
  { tag: 'far', kind: 'own', rows: 4 },
  { tag: 'lonely', kind: 'own', rows: 9 },
], [['pin', 'near', 6], ['near', 'far', 2], ['pin', 'far', 3]]);

const FIELD = seaStars(FIXTURE, seaRegions(FIXTURE));

describe('the marks of a wall', () => {
  it('stands a star at the middle of the region its tag owns', () => {
    /* The marks are read off the very regions they were built from, so a star's own region
       is the packing's object and not a copy of it. */
    const regions = seaRegions(FIXTURE);
    const field = seaStars(FIXTURE, regions);
    const at = new Map(field.stars.map((s) => [s.tag, s]));

    expect(field.stars.map((s) => s.tag).sort()).toEqual(regions.map((r) => r.tag).sort());
    for (const r of regions) {
      const star = at.get(r.tag);
      expect(star?.region).toBe(r);
      expect(star?.lon).toBeCloseTo((r.lon0 + r.lon1) / 2, 9);
      expect(star?.rise).toBeCloseTo((r.rise0 + r.rise1) / 2, 9);
      expect(star?.rows).toBe(r.rows);
      expect(star?.kind).toBe(r.kind);
    }
  });

  it('carries the scale the stars are drawn by, and how many tags the packing left out', () => {
    expect(FIELD.maxRows).toBe(30);
    /* One tag of the fixture reaches no pin, so the packing places all four of them. */
    expect(FIELD.stars.length).toBe(4);
    expect(FIELD.kept).toBe(4);
  });

  it('marks each pair once, heaviest first, and caps the tail', () => {
    const edges = seaStars(FIXTURE, seaRegions(FIXTURE), { maxEdges: 2 });

    expect(FIELD.edges.map((e) => `${e.a}|${e.b}|${e.w}`)).toEqual([
      'far|pin|3', 'far|near|2', 'near|pin|6',
    ].sort((a, b) => Number(b.split('|')[2]) - Number(a.split('|')[2])));
    expect(FIELD.maxEdge).toBe(6);
    expect(edges.edges.length).toBe(2);
    expect(edges.edges[0].w).toBe(6);
  });

  it('leaves out an edge that names a tag the packing did not keep', () => {
    const graph = graphOf([{ tag: 'pin', kind: 'pinned', rows: 1 }]);
    graph.edges.set('pin', new Map([['absent', 4]]));

    expect(seaStars(graph, seaRegions(graph)).edges).toEqual([]);
  });

  it('takes a star\u2019s lexical share from the graph, or from the caller', () => {
    const at = new Map(FIELD.stars.map((s) => [s.tag, s]));

    expect(at.get('pin')?.lambda).toBe(0.7);
    expect(at.get('near')?.lambda).toBeUndefined();
    const asked = seaStars(FIXTURE, seaRegions(FIXTURE), { lambda: () => 0.25 });
    expect(asked.stars.every((s) => s.lambda === 0.25)).toBe(true);
  });
});

describe('what a star is drawn as', () => {
  it('grows the width with the rows that kept the tag and stays inside its bounds', () => {
    const widest = starSize(100, 100);
    const narrowest = starSize(1, 100);

    expect(narrowest).toBeLessThan(widest);
    expect(narrowest).toBeCloseTo(0.0135, 4);
    expect(widest).toBeCloseTo(0.045, 9);
    expect(starSize(1, 0)).toBeLessThanOrEqual(widest);
  });

  it('draws the widest tag opaque and a tag one row kept faint', () => {
    const faint = starOpacity(1, 1000);
    const solid = starOpacity(1000, 1000);

    expect(faint).toBeGreaterThan(0.2);
    expect(faint).toBeLessThan(0.3);
    expect(solid).toBeCloseTo(1, 9);
    expect(starOpacity(4, 4)).toBe(1);
  });
});

describe('the legend', () => {
  it('counts each kind, named by the taxonomy the wall was packed in', () => {
    const line = skyLegend(FIELD, GRAPH_REACH, Object.keys(GRAPH_REACH));

    /* Both `near` and `far` are held beside the pin by a row, and `lonely` reaches no pin. */
    expect(line).toContain('✓ pinned tag 1');
    expect(line).toContain('◉ related tag 2');
    expect(line).toContain('◌ remote tag 0');
    expect(line).toContain('○ own cluster 1');
  });

  it('lists a kind the packing placed nothing on, and is empty for no taxonomy', () => {
    expect(skyLegend(FIELD, GRAPH_REACH, ['alias'])).toBe('≈ pin alias 0');
    expect(skyLegend(FIELD, {})).toBe('');
  });
});

describe('reading a graph without a packing', () => {
  it('falls back to the node\u2019s own kind, and to `own` for a tag the pass never marked', () => {
    expect(kindOf(FIXTURE, 'pin')).toBe('pinned');
    expect(kindOf(FIXTURE, 'near')).toBe('own');
  });

  it('marks a wall of no regions without stars or edges', () => {
    const empty: SeaRegion[] = [];
    const field = seaStars(FIXTURE, empty);

    expect(field.stars).toEqual([]);
    expect(field.edges).toEqual([]);
    expect(field.maxRows).toBe(1);
    expect(field.maxEdge).toBe(1);
  });
});
