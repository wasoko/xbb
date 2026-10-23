/**
 * seaTags.test.ts — the generated taxonomy as the wall reads it.
 *
 * The table is generated prose, so the tests pin what a region says about itself: the header
 * and separator are not tags, a dash cell is absent rather than zero, and the relation
 * sections are read back into the web, theme and burst edges the hover draws.
 */

import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import type { Da } from '../../src/sdb';
import {
  cropText, graphFromTags, parseRelations, parseTaxonomy, parseTaxonomyDoc, relationsOf,
  rowAction, seaPinsOf, seaRowOf, type SeaRelations,
} from '../../src/ui/seaTags';

const TABLE = [
  '### Web',
  '- alpha ↔ beta ×12',
  '- beta ↔ gamma ×3',
  '',
  '### Themes',
  '- area/topic → area · 9×',
  '',
  '### Bursts',
  '- #0 · 40 rows: alpha 2.50 · beta 1.25 · gamma 0.75',
  '',
  '### Aliases',
  '- a → alpha',
  '',
  '### Synonyms',
  '- alph → alpha · 4×',
  '',
  '| tag | reach | kind | score | weight | freq | λ | burst | top |',
  '|---|---|---|---|---|---|---|---|---|',
  '| alpha | pinned | pinned | 0.900 | 40 | 40 | 0.40 | 0 | textRank |',
  '| area | pinned | pinned | 0.800 | 30 | 30 | 0.30 | - | bm25 |',
  '| area/topic | related | theme | 4.000 | 9 | 9 | 0.20 | - | - |',
  '| beta | related | head | 0.700 | 20 | 20 | 0.50 | 0 | textRank |',
  '| gamma | own | own | 0.600 | 10 | 10 | 0.60 | - | - |',
].join('\n');

describe('the taxonomy table', () => {
  it('reads the table rows and nothing else', () => {
    const tags = parseTaxonomy(TABLE);
    expect(tags.map((tag) => tag.tag)).toEqual(['alpha', 'area', 'area/topic', 'beta', 'gamma']);
    expect(tags[0]).toMatchObject({
      reach: 'pinned', kind: 'pinned', score: 0.9, weight: 40, lambda: 0.4, burst: 0, top: 'textRank',
    });
  });

  it('reads a dash as absent', () => {
    const tags = parseTaxonomy(TABLE);
    expect(tags[1].burst).toBeUndefined();
    expect(tags[2].lambda).toBeCloseTo(0.2);
  });
});

describe('the relation sections', () => {
  const relations = parseRelations(TABLE);

  it('reads web pairs, themes, bursts, aliases and synonyms', () => {
    expect(relations.web).toEqual([
      { a: 'alpha', b: 'beta', w: 12 },
      { a: 'beta', b: 'gamma', w: 3 },
    ]);
    expect(relations.themes).toEqual([{ theme: 'area/topic', anchor: 'area', count: 9 }]);
    expect(relations.bursts).toEqual([{
      id: 0, rows: 40,
      tags: [{ tag: 'alpha', score: 2.5 }, { tag: 'beta', score: 1.25 }, { tag: 'gamma', score: 0.75 }],
    }]);
    expect(relations.aliases).toEqual([{ from: 'a', to: 'alpha' }]);
    expect(relations.synonyms).toEqual([{ from: 'alph', to: 'alpha', count: 4 }]);
  });

  it('returns empty lists for a document with no relation sections', () => {
    expect(parseRelations('| tag | reach | kind |\n|---|---|---|\n')).toEqual({
      web: [], themes: [], bursts: [], aliases: [], synonyms: [],
    });
  });
});

describe('relationsOf', () => {
  const doc = parseTaxonomyDoc(TABLE);
  const graph = graphFromTags(doc.tags, doc.relations);

  it('puts the pin first, then the table relations', () => {
    const relations = relationsOf('beta', {
      relations: doc.relations, graph, pin: 'alpha', burst: 0,
    });
    expect(relations[0]).toMatchObject({ kind: 'pin', tag: 'alpha' });
    expect(relations.some((rel) => rel.tag === 'gamma' && (rel.kind === 'web' || rel.kind === 'burst'))).toBe(true);
    expect(relations.some((rel) => rel.kind === 'burst' && rel.tag === 'alpha')).toBe(false);
    expect(relations.some((rel) => rel.kind === 'pin' && rel.tag === 'alpha')).toBe(true);
  });

  it('links a theme to its anchor in both directions', () => {
    const down = relationsOf('area/topic', { relations: doc.relations, graph });
    expect(down.some((rel) => rel.kind === 'theme' && rel.tag === 'area')).toBe(true);
    const up = relationsOf('area', { relations: doc.relations, graph });
    expect(up.some((rel) => rel.kind === 'theme' && rel.tag === 'area/topic')).toBe(true);
  });

  it('never returns the tag itself', () => {
    const relations = relationsOf('alpha', { relations: doc.relations, graph, burst: 0 });
    expect(relations.every((rel) => rel.tag !== 'alpha')).toBe(true);
  });
});

describe('tags from the table alone', () => {
  const doc = parseTaxonomyDoc(TABLE);
  const graph = graphFromTags(doc.tags, doc.relations);

  it('makes the reaches roots and the themes edges', () => {
    expect([...graph.roots]).toEqual(['alpha', 'area']);
    expect(graph.edges.get('area')?.get('area/topic')).toBe(9);
    expect(graph.kind.get('area/topic')).toBe('theme');
  });
});

describe('pin cards as columns', () => {
  const doc = parseTaxonomyDoc(TABLE);
  const graph = graphFromTags(doc.tags, doc.relations);
  const card = (ref: string, txt: string, dt: Date, modAt?: Date): Da => ({
    ref, txt, type: 'md', tags: ['pin'], dt, modAt, rec: {},
  });

  it('reads a card at its own top heading level', () => {
    const cards = seaPinsOf([
      card('pin:a', '# #alpha\n## #area', new Date('2026-01-01')),
    ], graph);
    expect(cards[0].columns).toEqual([['alpha']]);
  });

  it('falls back to the second level when a card has no first level heading', () => {
    const cards = seaPinsOf([
      card('pin:a', '## #alpha\n## #area\n### #beta', new Date('2026-01-01')),
    ], graph);
    expect(cards[0].columns).toEqual([['alpha'], ['area']]);
  });

  it('keeps the tags one heading names in one column', () => {
    const cards = seaPinsOf([
      card('pin:a', '# #alpha #area\n# #alpha', new Date('2026-01-01')),
    ], graph);
    expect(cards[0].columns).toEqual([['alpha', 'area']]);
  });

  it('orders the cards by the later of their dt and modAt', () => {
    const cards = seaPinsOf([
      card('pin:old', '## #alpha', new Date('2026-01-01')),
      card('pin:new', '## #area', new Date('2026-01-01'), new Date('2026-02-01')),
    ], graph);
    expect(cards.map((entry) => entry.ref)).toEqual(['pin:new', 'pin:old']);
  });
});

describe('cropText and rows', () => {
  it('keeps one line and marks a cut tail', () => {
    expect(cropText('a\nb   c', 10)).toBe('a b c');
    expect(cropText('abcdefghij', 5)).toBe('abcd…');
  });

  it('routes a document and an address to their own openings', () => {
    expect(rowAction({ ref: 'notes/x.md', txt: 'x', type: 'md', rec: {} })).toBe('editor');
    expect(rowAction({ ref: 'https://example.com/a', txt: 'a', type: 'tab', rec: {} })).toBe('link');
    const row = seaRowOf({ ref: 'https://example.com/a', txt: 'a long title', type: 'tab', rec: {} });
    expect(row.action).toBe('link');
    expect(row.text).toBe('a long title');
  });
});

/** A relation set with every section present, for the shape of the type. */
const TYPED: SeaRelations = parseRelations(TABLE);
describe('relation set', () => {
  it('holds a burst score per tag', () => {
    expect(TYPED.bursts[0].tags[0]).toEqual({ tag: 'alpha', score: 2.5 });
  });
});
