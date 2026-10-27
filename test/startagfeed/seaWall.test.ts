/**
 * seaWall.test.ts — the tag canvas as a function of the table.
 *
 * The wall owes four things to a reader: the pinned headings share one band whose top edge is
 * sea level at longitude 0, one column each, with the newest pin card starting on the star and
 * the rest reading rightwards; a lone card divides the band into its top level headings, with
 * the next heading level tiled below; the recent band starts on the other side of the same
 * meridian and runs leftwards; and every point is a row the table actually kept. The tail
 * stays on the rear half. The tests pin those, the mirrored half above the horizon, and the
 * determinism of the scatter.
 */

import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { buildWall, regionOnWall } from '../../src/ui/seaWall';
import { graphFromTags } from '../../src/ui/seaTags';
import type { SeaRelations, SeaRow, SeaTag } from '../../src/ui/seaTags';

const TAGS: SeaTag[] = [
  { tag: 'alpha', reach: 'pinned', kind: 'pinned', score: 0.9, weight: 40, freq: 40, lambda: 0.4 },
  { tag: 'area', reach: 'pinned', kind: 'pinned', score: 0.8, weight: 30, freq: 30, lambda: 0.3 },
  { tag: 'area/topic', reach: 'related', kind: 'theme', score: 4, weight: 9, freq: 9 },
  { tag: 'beta', reach: 'related', kind: 'head', score: 0.7, weight: 20, freq: 20, lambda: 0.5 },
  { tag: 'gamma', reach: 'own', kind: 'own', score: 0.6, weight: 10, freq: 10, lambda: 0.6 },
  { tag: 'delta', reach: 'own', kind: 'own', score: 0.5, weight: 4, freq: 4 },
];

const RELATIONS = {
  web: [
    { a: 'alpha', b: 'beta', w: 12 },
    { a: 'beta', b: 'gamma', w: 3 },
  ],
  themes: [{ theme: 'area/topic', anchor: 'area', count: 9 }],
  bursts: [],
  aliases: [],
  synonyms: [],
};

const GRAPH = graphFromTags(TAGS, RELATIONS);

const row = (tag: string, i: number): SeaRow => ({
  key: `${tag}-${i}`,
  ref: `https://example.com/${tag}/${i}`,
  text: `${tag} row ${i}`,
  label: `${tag} row ${i}`,
  action: 'link',
  type: 'tab',
});

const rowsOf = (tag: string): SeaRow[] => [
  row(tag, 0), row(tag, 1), row(tag, 2), row(tag, 3), row(tag, 4), row(tag, 5), row(tag, 6),
];

const WALL = buildWall(GRAPH, TAGS, rowsOf);
const SHAPE = { pinCol: 46, areaPerRow: 4 };

/** Five pinned tags, so the band shows where each rank lands. */
const BAND_TAGS: SeaTag[] = ['one', 'two', 'three', 'four', 'five'].map((tag, i) => ({
  tag, reach: 'pinned', kind: 'pinned', score: 1 - i * 0.1, weight: 10 - i, freq: 10 - i,
}));

const NO_EDGES: SeaRelations = { web: [], themes: [], bursts: [], aliases: [], synonyms: [] };
const BAND_GRAPH = graphFromTags(BAND_TAGS, NO_EDGES);
const BAND_ROWS = (tag: string): SeaRow[] => [row(tag, 0)];

/** One card per pinned tag, newest first by `stamp`. */
const BAND_PINS = BAND_TAGS.map((tag, i) => ({
  ref: `pin:${tag.tag}`, columns: [[tag.tag]], stamp: BAND_TAGS.length - i,
}));

describe('the pin band', () => {
  const wall = buildWall(GRAPH, TAGS, rowsOf, SHAPE);

  it('hangs the newest pinned heading from sea level at the star edge', () => {
    expect(wall.star).toEqual({ lon: 0, rise: 0, pin: 'alpha' });
    const alpha = wall.pins.find((pin) => pin.tag === 'alpha');
    expect(alpha?.star).toBe(true);
    expect(alpha?.rise1).toBeCloseTo(0, 9);
    expect(alpha?.lon0).toBeCloseTo(-46, 9);
    expect(alpha?.lon1).toBeCloseTo(0, 9);
  });

  it('stands every pinned heading from sea level down, side by side', () => {
    const sorted = [...wall.pins].sort((a, b) => a.lon0 - b.lon0);
    for (const pin of sorted) {
      expect(pin.rise1).toBeCloseTo(0, 9);
      expect(pin.rise0).toBeLessThan(0);
    }
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i].lon0).toBeCloseTo(sorted[i - 1].lon1, 6);
    }
  });

  it('gives a pinned heading its links as points, like any other cell', () => {
    for (const region of wall.regions) {
      if (region.reach !== 'pinned' && region.reach !== 'alias') continue;
      if (region.reflection) continue;
      expect(region.points.length).toBeGreaterThan(0);
      for (const point of region.points) {
        expect(point.lon).toBeGreaterThanOrEqual(region.lon0);
        expect(point.lon).toBeLessThanOrEqual(region.lon1);
        expect(point.rise).toBeGreaterThanOrEqual(region.rise0);
        expect(point.rise).toBeLessThanOrEqual(region.rise1);
      }
    }
  });
});

describe('the pin cards', () => {
  const SHAPE = { pinCol: 20 };

  it('puts the newest card at the star and reads the rest rightwards', () => {
    const wall = buildWall(BAND_GRAPH, BAND_TAGS, BAND_ROWS, { ...SHAPE, pins: BAND_PINS });
    expect(wall.pins.map((pin) => pin.tag)).toEqual(['one', 'two', 'three', 'four', 'five']);
    expect(wall.star.pin).toBe('one');
    expect(wall.arc).toEqual({ start: 90, end: 260 });
  });

  it('descends by date as it turns right from the star', () => {
    const wall = buildWall(BAND_GRAPH, BAND_TAGS, BAND_ROWS, { ...SHAPE, pins: BAND_PINS });
    const stamps = new Map(BAND_PINS.map((pin) => [pin.columns[0][0], pin.stamp]));
    const pins = wall.pins;
    for (let i = 1; i < pins.length; i++) {
      expect(stamps.get(pins[i].tag)!).toBeLessThan(stamps.get(pins[i - 1].tag)!);
      expect(pins[i].lon1).toBeCloseTo(pins[i - 1].lon0, 9);
    }
  });

  it('tiles the band with the columns, the newest at the star edge', () => {
    const wall = buildWall(BAND_GRAPH, BAND_TAGS, BAND_ROWS, { ...SHAPE, pins: BAND_PINS });
    const sorted = [...wall.pins].sort((a, b) => a.lon0 - b.lon0);
    expect(sorted[0].lon0).toBeCloseTo(-100, 9);
    expect(sorted[sorted.length - 1].lon1).toBeCloseTo(0, 9);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i].lon0).toBeCloseTo(sorted[i - 1].lon1, 6);
    }
  });

  it('starts a lone card at the star and reads its headings rightwards', () => {
    const wall = buildWall(BAND_GRAPH, BAND_TAGS, BAND_ROWS, {
      ...SHAPE,
      pins: [{ ref: 'pin:solo', columns: [['one'], ['two'], ['three']], stamp: 9 }],
    });
    expect(wall.pins.map((pin) => pin.tag)).toEqual(['one', 'two', 'three']);
    expect(wall.star.pin).toBe('one');
    expect(wall.pins[0].lon0).toBeCloseTo(-20, 9);
    expect(wall.pins[0].lon1).toBeCloseTo(0, 9);
    expect(wall.pins[2].lon0).toBeCloseTo(-60, 9);
  });

  it('stacks the tags one heading names down its column', () => {
    const wall = buildWall(BAND_GRAPH, BAND_TAGS, BAND_ROWS, {
      ...SHAPE,
      pins: [{ ref: 'pin:solo', columns: [['one', 'two'], ['three']], stamp: 9 }],
    });
    const [one, two, three] = wall.pins;
    expect(wall.star.pin).toBe('one');
    expect(two.lon0).toBeCloseTo(one.lon0, 9);
    expect(two.lon1).toBeCloseTo(one.lon1, 9);
    expect(two.rise1).toBeLessThan(one.rise0);
    expect(three.lon0).toBeCloseTo(one.lon0 - 20, 9);
    expect(three.rise1).toBeCloseTo(0, 9);
  });

  it('keeps a card’s headings together as one run to the right of the star', () => {
    const wall = buildWall(BAND_GRAPH, BAND_TAGS, BAND_ROWS, {
      ...SHAPE,
      pins: [
        { ref: 'pin:a', columns: [['one'], ['two']], stamp: 3 },
        { ref: 'pin:b', columns: [['three']], stamp: 2 },
        { ref: 'pin:c', columns: [['four']], stamp: 1 },
      ],
    });
    expect(wall.pins.map((pin) => pin.tag)).toEqual(['one', 'two', 'three', 'four']);
    expect(wall.star.pin).toBe('one');
    expect(wall.pins[0].lon0).toBeCloseTo(-20, 9);
    expect(wall.pins[1].lon1).toBeCloseTo(-20, 9);
    expect(wall.pins[2].lon1).toBeCloseTo(-40, 9);
  });

  it('draws no band when no card roots the graph', () => {
    const cloudTags: SeaTag[] = ['cedar', 'coral'].map((tag) => ({
      tag, reach: 'own', kind: 'own', score: 0.5, weight: 4, freq: 4,
    }));
    const bare = buildWall(graphFromTags(cloudTags, NO_EDGES), cloudTags, BAND_ROWS);
    expect(bare.pins).toEqual([]);
    expect(bare.star).toEqual({ lon: 0, rise: 0, pin: null });
    expect(bare.arc).toEqual({ start: 90, end: 270 });
    const clouds = bare.regions.filter((region) => !region.reflection);
    expect(clouds[0].lon0).toBeCloseTo(90, 9);
    expect(clouds[clouds.length - 1].lon1).toBeCloseTo(270, 6);
  });

  it('draws the next heading level as a treemap under its top pin', () => {
    const wall = buildWall(BAND_GRAPH, BAND_TAGS, BAND_ROWS, {
      ...SHAPE,
      pins: [{
        ref: 'pin:nested', columns: [['one']], children: [['two']], stamp: 9,
      }],
    });
    expect(wall.pins.map((pin) => pin.tag)).toEqual(['one']);
    const one = wall.regions.find((region) => region.tag === 'one');
    const two = wall.regions.find((region) => region.tag === 'two');
    expect(two?.side).toBe('pin');
    expect(two?.depth).toBe(1);
    expect(two?.parent).toBe('one');
    expect(two?.lon0).toBeCloseTo(one!.lon0, 9);
    expect(two?.lon1).toBeCloseTo(one!.lon1, 9);
    expect(two?.rise1).toBeLessThan(one!.rise0);
  });
});

describe('the recent band', () => {
  const wall = buildWall(GRAPH, TAGS, rowsOf, {
    pinCol: 20,
    emerging: [{ tag: 'gamma', score: 3, children: ['delta'] }],
  });
  const recent = wall.recent[0];
  const child = wall.regions.find((region) => region.tag === 'delta');

  it('starts at the star edge and runs leftwards from it', () => {
    expect(recent.tag).toBe('gamma');
    expect(recent.side).toBe('recent');
    expect(recent.lon0).toBeCloseTo(0, 9);
    expect(recent.lon1).toBeCloseTo(20, 9);
    expect(wall.pins.every((pin) => pin.lon1 <= 0)).toBe(true);
  });

  it('draws its one-hop neighbours as the treemap below it', () => {
    expect(child?.side).toBe('recent');
    expect(child?.depth).toBe(1);
    expect(child?.parent).toBe('gamma');
    expect(child?.lon0).toBeCloseTo(recent.lon0, 9);
    expect(child?.lon1).toBeCloseTo(recent.lon1, 9);
    expect(child?.rise1).toBeLessThan(recent.rise0);
  });

  it('keeps the recent tags out of the rear cloud tail', () => {
    const tail = wall.regions.filter((region) => region.side === 'tail' && !region.reflection);
    expect(tail.some((region) => region.tag === 'gamma')).toBe(false);
    expect(tail.some((region) => region.tag === 'delta')).toBe(false);
  });
});

describe('recency', () => {
  it('dims a row inside its own tag region, not against the whole wall', () => {
    const stamped = (tag: string): SeaRow[] => [
      { ...row(tag, 0), stamp: tag === 'one' ? 2_000 : 1_000 },
      { ...row(tag, 1), stamp: tag === 'one' ? 1_000 : 500 },
    ];
    const wall = buildWall(BAND_GRAPH, BAND_TAGS, stamped, { pinCol: 20 });
    const at = (tag: string, stamp: number) =>
      wall.points.find((point) => point.tag === tag && point.stamp === stamp)?.recency;
    /* `one` holds the wall's newest row and `two` an older one; each reads its own span, so
       an old tag is not a dim tag. */
    expect(at('one', 2_000)).toBeCloseTo(1, 9);
    expect(at('one', 1_000)).toBeCloseTo(0, 9);
    expect(at('two', 1_000)).toBeCloseTo(1, 9);
    expect(at('two', 500)).toBeCloseTo(0, 9);
    expect(wall.star.recency).toBeCloseTo(1, 9);
  });

  it('keeps a region of one stamped row at full strength', () => {
    const wall = buildWall(BAND_GRAPH, BAND_TAGS,
      (tag) => (tag === 'one' ? [{ ...row(tag, 0), stamp: 5_000 }] : BAND_ROWS(tag)), { pinCol: 20 });
    expect(wall.points.find((point) => point.tag === 'one')?.recency).toBeCloseTo(1, 9);
  });

  it('leaves a star undimmed when its tag kept no row', () => {
    const wall = buildWall(BAND_GRAPH, BAND_TAGS,
      (tag) => (tag === 'one' ? [] : BAND_ROWS(tag)), { pinCol: 20 });
    expect(wall.star.recency).toBeUndefined();
  });
});

describe('the rear tail', () => {
  const wall = buildWall(GRAPH, TAGS, rowsOf, SHAPE);
  const clouds = wall.regions.filter((region) => !region.reflection
    && region.reach !== 'pinned' && region.reach !== 'alias');

  it('starts at the rear edge and tiles the arc with no gap', () => {
    const sorted = [...clouds].sort((a, b) => a.lon0 - b.lon0);
    expect(sorted[0].lon0).toBeCloseTo(wall.arc.start, 9);
    expect(sorted[sorted.length - 1].lon1).toBeCloseTo(wall.arc.end, 9);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i].lon0).toBeCloseTo(sorted[i - 1].lon1, 6);
    }
  });

  it('keeps every cloud below the horizon', () => {
    for (const cloud of clouds) expect(cloud.rise1).toBeLessThanOrEqual(0);
  });

  it('mirrors every cloud above the horizon, dark and unlabelled', () => {
    const reflections = wall.regions.filter((region) => region.reflection);
    expect(reflections.length).toBe(clouds.length);
    for (const reflection of reflections) {
      expect(reflection.above).toBe(true);
      expect(reflection.label).toBe(false);
      expect(reflection.points).toEqual([]);
      expect(reflection.rise0).toBeGreaterThanOrEqual(0);
    }
    expect(wall.above).toBeGreaterThan(0);
    expect(wall.below).toBeLessThan(0);
  });

  it('draws a name in every cell below the horizon', () => {
    for (const region of wall.regions) {
      expect(region.label).toBe(!region.reflection);
    }
  });
});

describe('the link points', () => {
  const wall = WALL;

  it('places every point inside the region it belongs to', () => {
    for (const region of wall.regions) {
      for (const point of region.points) {
        expect(point.tag).toBe(region.tag);
        expect(point.lon).toBeGreaterThanOrEqual(region.lon0);
        expect(point.lon).toBeLessThanOrEqual(region.lon1);
        expect(point.rise).toBeGreaterThanOrEqual(region.rise0);
        expect(point.rise).toBeLessThanOrEqual(region.rise1);
      }
    }
  });

  it('places only rows the tag was kept by, and never in the reflection', () => {
    for (const point of wall.points) {
      expect(point.ref.startsWith(`https://example.com/${point.tag}/`)).toBe(true);
      expect(point.above).toBe(false);
    }
  });

  it('shows every row as a point, with no count kept back', () => {
    for (const region of wall.regions) {
      if (region.reflection) continue;
      expect(region.points.length).toBe(region.rows.length);
    }
  });

  it('places every row of a crowded cell inside that cell', () => {
    const many = (tag: string): SeaRow[] => Array.from({ length: 240 }, (_, i) => row(tag, i));
    const crowded = buildWall(GRAPH, TAGS, many, SHAPE);
    const beta = crowded.regions.find((region) => region.tag === 'beta' && !region.reflection);
    expect(beta?.points).toHaveLength(240);
    for (const point of beta?.points ?? []) {
      expect(point.lon).toBeGreaterThanOrEqual(beta!.lon0);
      expect(point.lon).toBeLessThanOrEqual(beta!.lon1);
      expect(point.rise).toBeGreaterThanOrEqual(beta!.rise0);
      expect(point.rise).toBeLessThanOrEqual(beta!.rise1);
    }
  });

  it('draws no points for a tag no row kept', () => {
    const wallNoRows = buildWall(GRAPH, TAGS, (tag) => (tag === 'delta' ? [] : rowsOf(tag)));
    const delta = wallNoRows.regions.find((region) => region.tag === 'delta' && !region.reflection);
    expect(delta?.points).toEqual([]);
  });

  it('lays the same points out every time', () => {
    const again = buildWall(GRAPH, TAGS, rowsOf);
    expect(JSON.stringify(again)).toBe(JSON.stringify(wall));
  });
});

describe('reading a place', () => {
  const wall = buildWall(GRAPH, TAGS, rowsOf, SHAPE);

  it('finds the region under the star', () => {
    expect(regionOnWall(wall.regions, 0, -1)?.tag).toBe('alpha');
  });

  it('reads a wrapped longitude as the cloud on the far side', () => {
    const far = wall.regions.find((region) => !region.reflection
      && region.lon0 > 180 && region.reach !== 'pinned' && region.reach !== 'alias');
    expect(far).toBeDefined();
    const observed = far!.lon0 + 1 - 360;
    expect(regionOnWall(wall.regions, observed, (far!.rise0 + far!.rise1) / 2)?.tag).toBe(far!.tag);
  });

  it('finds nothing in the black above the reflections', () => {
    expect(regionOnWall(wall.regions, 0, 5000)).toBeNull();
  });
});
