/**
 * seaRegion.test.ts — the tag graph packed into regions that fill the sea's cylinder.
 *
 * `seaRegion` owns where every tag's rectangle lands: the pins hold a column at the centre,
 * a pin's spellings take the band under it, and the rest of the tags fill the two strips
 * beside the column, packed in shelves whose areas are proportional to the rows that kept
 * them. The tests check the six things that decide that packing: the column is the curated
 * half, a spelling sits under its own pin, a tag no pin reaches ends the east strip, area
 * follows rows, a shelf closes its strip, and no two regions overlap.
 *
 * The fixture graph is written out by hand rather than built, because the packing is a pure
 * function of a graph and a hand-built one says exactly what is being packed.
 */

import { describe, expect, it } from 'vitest';
import {
  SEA_LIMITS, SEA_REGION, clusterOf, labelFontPx, regionArea, regionAt, regionCentre,
  regionTiers, regionsInCell, seaRegions,
  type SeaRegion,
} from '../../src/ui/seaRegion';
import type { GraphNodeKind, TagGraph } from '../../src/ui/restGraph';
import { kindOf } from '../../src/ui/seaStars';

/** One node of the fixture graph. */
interface Node {
  tag: string;
  kind: GraphNodeKind;
  rows: number;
}

/**
 * A graph as `restGraph.buildTagGraph` returns one, over the nodes given.
 *
 * @param nodes the tags, with their kind and how many rows kept them
 * @param pairs edges as `[a, b, weight]`
 * @param aliases `[tag, the pinned tag it is a spelling of]` pairs
 * @returns the graph
 */
function graphOf(
  nodes: Node[], pairs: [string, string, number][] = [], aliases: [string, string][] = [],
): TagGraph {
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
    alias: new Map(aliases),
    lambda: new Map(),
  };
}

/** Regions keyed by tag, for the assertions that read one of them. */
const byTag = (regions: SeaRegion[]): Map<string, SeaRegion> =>
  new Map(regions.map((r) => [r.tag, r]));

/** Whether two rectangles share more than an edge. */
function overlaps(a: SeaRegion, b: SeaRegion): boolean {
  const lon = Math.min(a.lon1, b.lon1) - Math.max(a.lon0, b.lon0);
  const rise = Math.min(a.rise1, b.rise1) - Math.max(a.rise0, b.rise0);
  return lon > 1e-9 && rise > 1e-9;
}

describe('the parts of the wall', () => {
  it('holds the pins in a column at the centre and every other tag outside it', () => {
    const graph = graphOf([
      { tag: 'curated', kind: 'pinned', rows: 12 },
      { tag: 'beside', kind: 'own', rows: 30 },
      { tag: 'far', kind: 'own', rows: 20 },
      { tag: 'lonely', kind: 'own', rows: 5 },
    ], [['curated', 'beside', 5], ['beside', 'far', 3]]);
    const at = byTag(seaRegions(graph));
    const band = SEA_REGION.pinCol / 2;

    const pin = at.get('curated');
    expect(pin?.lon0).toBe(-band);
    expect(pin?.lon1).toBe(band);
    expect(pin?.rise1).toBe(0);

    for (const behind of ['beside', 'far', 'lonely']) {
      const r = at.get(behind);
      expect(Math.min(Math.abs(r?.lon0 ?? 0), Math.abs(r?.lon1 ?? 0))).toBeGreaterThanOrEqual(band);
    }
  });

  it('takes the band along the bottom of a pin for its own spellings', () => {
    const graph = graphOf([
      { tag: 'pin', kind: 'pinned', rows: 10 },
      { tag: 'one', kind: 'own', rows: 2 },
      { tag: 'two', kind: 'own', rows: 1 },
    ], [], [['one', 'pin'], ['two', 'pin']]);
    const at = byTag(seaRegions(graph));
    const pin = at.get('pin');
    const one = at.get('one');
    const two = at.get('two');

    expect(one?.cluster).toBe('pin');
    expect(two?.cluster).toBe('pin');
    expect(one?.rise1).toBe(pin?.rise0);
    expect(one?.rise0).toBe(two?.rise0);
    expect(one?.rise1).toBe(two?.rise1);
    expect(one?.lon0).toBe(-SEA_REGION.pinCol / 2);
    expect(two?.lon1).toBe(SEA_REGION.pinCol / 2);
  });

  it('answers a tag with the pin its strongest hop reaches', () => {
    const graph = graphOf([
      { tag: 'near', kind: 'pinned', rows: 9 },
      { tag: 'other', kind: 'pinned', rows: 4 },
      { tag: 'beside', kind: 'own', rows: 3 },
      { tag: 'two-steps', kind: 'own', rows: 2 },
    ], [['near', 'beside', 6], ['beside', 'two-steps', 2]]);
    const heads = new Set(['near', 'other']);

    expect(clusterOf(graph, 'beside', heads)).toBe('near');
    expect(clusterOf(graph, 'two-steps', heads)).toBe('near');
    expect(clusterOf(graph, 'unrelated', heads)).toBeNull();
    expect(byTag(seaRegions(graph)).get('beside')?.cluster).toBe('near');
  });

  it('sends a tag no pin reaches to the end of the east strip', () => {
    const graph = graphOf([
      { tag: 'pinA', kind: 'pinned', rows: 10 },
      { tag: 'pinB', kind: 'pinned', rows: 5 },
      { tag: 'beside', kind: 'own', rows: 900 },
      { tag: 'eastOne', kind: 'own', rows: 900 },
      { tag: 'eastTwo', kind: 'own', rows: 900 },
      { tag: 'eastThree', kind: 'own', rows: 900 },
      { tag: 'lonely', kind: 'own', rows: 3 },
    ], [
      ['pinA', 'beside', 5], ['pinB', 'eastOne', 5],
      ['pinB', 'eastTwo', 4], ['pinB', 'eastThree', 3],
    ]);
    const at = byTag(seaRegions(graph));
    const lonely = at.get('lonely')!;
    const east = ['eastOne', 'eastTwo', 'eastThree'].map((tag) => at.get(tag)!);

    /* The first pin's cluster holds the west strip, the second's the east one. */
    expect(at.get('beside')?.lon0).toBeLessThan(-SEA_REGION.pinCol / 2);
    expect(east.every((r) => r.lon0 >= SEA_REGION.pinCol / 2)).toBe(true);
    expect(lonely.lon0).toBeGreaterThanOrEqual(SEA_REGION.pinCol / 2);
    expect(lonely.cluster).toBeUndefined();
    /* The tail of the reading is packed after the clustered run, so no clustered tag is
       pushed below it. */
    expect(east[0].rise1).toBeGreaterThan(lonely.rise1);
    expect(Math.min(...east.map((r) => r.rise1))).toBeGreaterThanOrEqual(lonely.rise1);
  });
});

describe('the packing', () => {
  it('gives a tag an area in proportion to the rows that kept it', () => {
    const graph = graphOf([
      { tag: 'pin', kind: 'pinned', rows: 10 },
      { tag: 'broad', kind: 'own', rows: 900 },
      { tag: 'narrow', kind: 'own', rows: 400 },
    ], [['pin', 'broad', 9], ['pin', 'narrow', 5]]);
    const at = byTag(seaRegions(graph));
    const broad = at.get('broad');
    const narrow = at.get('narrow');

    expect(broad).toBeDefined();
    expect(narrow).toBeDefined();
    /* Both ask for more wall than the floors give them, so the ratio is the rows' own. */
    expect(regionArea(broad!)).toBeGreaterThan(regionArea(narrow!));
    expect(regionArea(broad!) / regionArea(narrow!)).toBeCloseTo(900 / 400, 6);
  });

  it('closes a shelf across its strip instead of leaving it ragged', () => {
    const nodes: Node[] = [{ tag: 'pin', kind: 'pinned', rows: 10 }];
    const pairs: [string, string, number][] = [];
    for (let i = 0; i < 4; i++) {
      const tag = `t${i}`;
      nodes.push({ tag, kind: 'own', rows: 100 });
      pairs.push(['pin', tag, 8]);
    }
    const regions = seaRegions(graphOf(nodes, pairs));
    const shelf = regions.filter((r) => r.rise1 === 0 && r.lon1 <= -SEA_REGION.pinCol / 2);
    const width = shelf.reduce((sum, r) => sum + (r.lon1 - r.lon0), 0);

    /* Four tags of one size do not fit one strip, so the first shelf takes three of them
       and stretches to the seam rather than stopping short. */
    expect(shelf.length).toBe(3);
    expect(width).toBeCloseTo(180 - SEA_REGION.pinCol / 2, 6);
  });

  it('never overlaps two regions and never leaves the wall', () => {
    const nodes: Node[] = [];
    const pairs: [string, string, number][] = [];
    const aliases: [string, string][] = [];
    for (let p = 0; p < 3; p++) {
      nodes.push({ tag: `pin${p}`, kind: 'pinned', rows: 20 - p * 5 });
      for (let i = 0; i < 12; i++) {
        const tag = `c${p}_${i}`;
        nodes.push({ tag, kind: 'own', rows: 1 + i * 7 });
        pairs.push([`pin${p}`, tag, 1 + i]);
      }
      for (let i = 0; i < 2; i++) {
        const tag = `s${p}_${i}`;
        nodes.push({ tag, kind: 'own', rows: 2 });
        aliases.push([tag, `pin${p}`]);
      }
    }
    const regions = seaRegions(graphOf(nodes, pairs, aliases));

    expect(regions.length).toBe(nodes.length);
    for (const r of regions) {
      expect(r.lon0).toBeGreaterThanOrEqual(-180);
      expect(r.lon1).toBeLessThanOrEqual(180);
      expect(r.lon0).toBeLessThan(r.lon1);
      expect(r.rise0).toBeLessThan(r.rise1);
    }
    for (let i = 0; i < regions.length; i++) {
      for (let j = i + 1; j < regions.length; j++) {
        expect(overlaps(regions[i], regions[j])).toBe(false);
      }
    }
  });

  it('keeps every pin when the cap bites', () => {
    const nodes: Node[] = [{ tag: 'pin', kind: 'pinned', rows: 3 }];
    for (let i = 0; i < 30; i++) nodes.push({ tag: `t${i}`, kind: 'own', rows: 100 - i });
    const regions = seaRegions(graphOf(nodes), { maxRegions: 4 });

    expect(regions.length).toBe(4);
    expect(regions.map((r) => r.tag)).toContain('pin');
  });

  it('reads the caller\u2019s own taxonomy, with the column wherever the caller puts it', () => {
    const graph = graphOf([
      { tag: 'pinned', kind: 'pinned', rows: 5 },
      { tag: 'head', kind: 'head', rows: 40 },
    ]);
    const regions = seaRegions(graph, { kind: (tag) => kindOf(graph, tag) });
    const at = byTag(regions);

    expect(at.get('pinned')?.kind).toBe('pinned');
    expect(at.get('head')?.kind).toBe('head');
  });
});

describe('reading the wall', () => {
  it('finds the region a place falls in, and nothing in a gap', () => {
    const graph = graphOf([
      { tag: 'pin', kind: 'pinned', rows: 10 },
      { tag: 'beside', kind: 'own', rows: 200 },
    ], [['pin', 'beside', 5]]);
    const regions = seaRegions(graph);
    const pin = byTag(regions).get('pin')!;

    expect(regionAt(regions, regionCentre(pin))).toBe(pin);
    /* The middle of the wall, one rise degree above the column's own band: between the
       column's bottom edge and the strips' first shelf there is nothing to fall in. */
    expect(regionAt([], { lon: 0, rise: 0 })).toBeNull();
  });

  it('lists the regions a cell overlaps, widest first', () => {
    const wall: SeaRegion[] = [
      region('wide', { lon0: -20, lon1: -10, rise0: 0, rise1: 5, rows: 9 }),
      region('thin', { lon0: -12, lon1: -2, rise0: 3, rise1: 8, rows: 2 }),
      region('elsewhere', { lon0: 100, lon1: 110, rise0: 0, rise1: 5 }),
    ];

    expect(regionsInCell(wall, { lonMin: -20, lonMax: -10, riseMin: 0, riseMax: 6 })
      .map((r) => r.tag)).toEqual(['wide', 'thin']);
  });
});

/** A region of the wall, with only the fields a test cares about written out. */
function region(tag: string, over: Partial<SeaRegion> = {}): SeaRegion {
  return {
    tag, kind: 'related', rows: 5, lon0: 0, lon1: 1, rise0: 0, rise1: 1, cluster: 'pin',
    ...over,
  };
}

/** The screen boxes a tier test reads its regions at, keyed by tag. */
const boxesOf = (sizes: Record<string, { w: number; h: number }>): Map<string, { w: number; h: number }> =>
  new Map(Object.entries(sizes));

describe('what a region is drawn as', () => {
  it('gives a big cloud its rows, a mid one its name and a small one a point', () => {
    const wall = [
      region('broad'), region('mid'), region('tiny'),
      region('pin', { kind: 'pinned', cluster: undefined }),
      region('alias', { kind: 'alias' }),
    ];
    const tiers = regionTiers(wall, boxesOf({
      broad: { w: 400, h: 60 }, mid: { w: 200, h: 40 }, tiny: { w: 20, h: 20 },
      pin: { w: 200, h: 40 }, alias: { w: 200, h: 40 },
    }));

    expect(tiers.get('broad')).toBe('blocks');
    expect(tiers.get('mid')).toBe('label');
    expect(tiers.get('tiny')).toBe('point');
    /* The curated half is what the wall is read for, so it carries its rows below the cloud
       floor: a pin, and a spelling of one, are never the regions that give way. */
    expect(tiers.get('pin')).toBe('blocks');
    expect(tiers.get('alias')).toBe('blocks');
  });

  it('spends its row budget on the widest regions and its name budget after that', () => {
    const sizes: Record<string, { w: number; h: number }> = {
      pin: { w: 300, h: 100 },
    };
    const wall = [region('pin', { kind: 'pinned', cluster: undefined })];
    for (let i = 0; i < 5; i++) {
      sizes[`c${i}`] = { w: 150 + i * 10, h: 100 };
      wall.push(region(`c${i}`));
    }
    const tiers = regionTiers(wall, boxesOf(sizes), {
      blockPx: 14000, pointPx: 4000, blocks: 1, labels: 2,
    });

    /* The pin is never the one that gives way; it spends the row budget, so no cloud opens
       its rows, and the two widest clouds take the name budget. */
    expect(tiers.get('pin')).toBe('blocks');
    expect(tiers.get('c4')).toBe('label');
    expect(tiers.get('c3')).toBe('label');
    expect(tiers.get('c2')).toBe('point');
    expect(tiers.get('c1')).toBe('point');
    expect(tiers.get('c0')).toBe('point');
  });

  it('draws a region too small to hold a name as a point, whoever it belongs to', () => {
    const wall = [
      region('pin', { kind: 'pinned', cluster: undefined }),
      region('spelling', { kind: 'alias' }),
    ];
    const tiers = regionTiers(wall, boxesOf({
      pin: { w: 40, h: 30 }, spelling: { w: 600, h: 300 },
    }));

    expect(tiers.get('pin')).toBe('point');
    expect(tiers.get('spelling')).toBe('blocks');
  });

  it('names no region the renderer gave no box', () => {
    expect(regionTiers([region('offscreen')], boxesOf({})).size).toBe(0);
  });

  it('sets a tag as large as its region allows, clipped rather than shrunk away', () => {
    /* A three-character name on a region 300 px wide and 60 tall takes most of its height. */
    expect(labelFontPx(300, 60, 3)).toBeCloseTo(60 * 0.86, 6);
    /* A fifty-one-character name cannot fit a 132 px region, so the floor holds and the box
       crops the tail rather than setting a size nothing can read. */
    expect(labelFontPx(132, 31, 51)).toBe(11);
    expect(labelFontPx(1e6, 1e6, 1)).toBe(220);
    /* The floors are a small view's fallback, so they sit below a one-row cloud's own
       measured box at the opening view and leave the budgets to decide the rest. */
    expect(SEA_LIMITS.pointPx).toBeLessThan(155 * 49);
    expect(SEA_LIMITS.blockPx).toBeGreaterThan(SEA_LIMITS.pointPx);
  });
});
