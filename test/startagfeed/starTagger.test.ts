/**
 * starTagger.test.ts — the `star.tagger.md` dialect, its mapping section and its
 * generated table.
 *
 * The document and the table are pure, so these tests read a document, resolve
 * aliases, and build the table from a graph without touching Dexie.
 */

import { describe, expect, it } from 'vitest';
import type { Da } from '../../src/sdb';
import type { RowTagReport, TagExplanation } from '../../src/srctag';
import {
  DEFAULT_STAR_SETUP, STAR_GRAPH_DEFAULT, STAR_TAGGER_DOC, STAR_TRACE_DEFAULT,
  defaultStarSetup, parseStarTaggerDoc, resolveAliases, setSection, setSetupValue,
  starLimits, starSetupFingerprint,
} from '../../src/starTagger';
import { buildTagGraph, pinReach, type TagGraph } from '../../src/ui/restGraph';
import { buildStarTaxonomy } from '../../src/starTaggerTrace';
import type { PinGraphSeed, StarTiming } from '../../src/ui/seaPinGraph';

const pin = (headings: string[]): Da =>
  ({ tid: -1, ref: 'pin/demo.md', type: 'md', txt: headings.map((h) => `## x #${h}`).join('\n'), tags: [], rec: {} });

const row = (tid: number): Da =>
  ({ tid, ref: `https://example.com/${tid}`, type: 'tab', txt: `row ${tid}`, tags: [], rec: {} });

const tagged = (tag: string, score = 1, top = 'bm25'): TagExplanation =>
  ({ tag, score, channels: [], text: '', top });

const report = (tid: number, tags: TagExplanation[], cluster = 0): RowTagReport => ({
  tid,
  ref: `https://example.com/${tid}`,
  dim: 'tid',
  window: { lo: 0, hi: 0, radius: 0, indices: [] },
  cluster,
  keywords: [],
  tags,
});

const timing: StarTiming = { config: 0, scan: 1, score: 2, graph: 3, total: 6 };

/** A seed over a real graph, with the reach the sea would have read. */
function seedOf(graph: TagGraph, pins: Da[], rows: Da[], reports: Map<number, RowTagReport>): PinGraphSeed {
  return {
    pins, rows, reports, graph,
    reach: pinReach(graph),
    recency: new Map(),
    trend: new Map(),
    setup: defaultStarSetup(),
    priorityTags: [],
    timings: timing,
  };
}

describe('parseStarTaggerDoc', () => {
  it('reads no overrides from the seeded template', () => {
    const doc = parseStarTaggerDoc(STAR_TAGGER_DOC);
    expect(doc.setup).toMatchObject({ ...DEFAULT_STAR_SETUP, alias: {}, notes: [] });
    expect(doc.setup.base).toBeUndefined();
    expect(doc.setup.trace).toBeUndefined();
    expect(doc.setup.maxGraph).toBeUndefined();
    expect(doc.setup.recent).toBeUndefined();
    expect(doc.setup.minRecent).toBeUndefined();
    expect(doc.setup.minLift).toBeUndefined();
    expect(doc.setup.noSyn).toBe(false);
    expect(doc.setup.noWeb).toBe(false);
    expect(doc.mapping).toBe('');
    expect(doc.notes).toContain('Edit Setup and Mapping');
  });

  it('reads the Setup keys and ignores comments and unusable values', () => {
    const doc = parseStarTaggerDoc(`# star.tagger

## Setup
# base: 999
base: 10000
trace: 555
maxGraph: 1111
recent: 300
minRecent: 4
minLift: 1.5
alias: js = javascript, k8s = kubernetes
noSyn: yes
noTheme: no
noWeb: yes
reset: yes
alpha: 2
floor: 0.2
ceil: nope

## Mapping
### Web
- a ↔ b ×2

## Notes
mine
`);
    expect(doc.setup.base).toBe(10_000);
    expect(doc.setup.trace).toBe(555);
    expect(doc.setup.maxGraph).toBe(1111);
    expect(doc.setup.recent).toBe(300);
    expect(doc.setup.minRecent).toBe(4);
    expect(doc.setup.minLift).toBe(1.5);
    expect(doc.setup.alias).toEqual({ js: 'javascript', k8s: 'kubernetes' });
    expect(doc.setup.reset).toBe(true);
    expect(doc.setup.noSyn).toBe(true);
    expect(doc.setup.noTheme).toBe(false);
    expect(doc.setup.noWeb).toBe(true);
    expect(doc.setup.alpha).toBe(2);
    expect(doc.setup.floor).toBe(0.2);
    expect(doc.setup.ceil).toBeUndefined();
    expect(doc.setup.notes).toContain('ignored ceil: nope');
    expect(doc.mapping).toBe('### Web\n- a ↔ b ×2');
    expect(doc.notes).toBe('mine');
  });
});

describe('starLimits', () => {
  it('uses base 5000, trace 555, maxGraph 1111 and the trend defaults', () => {
    expect(starLimits(defaultStarSetup())).toEqual({
      base: 5000, trace: STAR_TRACE_DEFAULT, maxGraph: STAR_GRAPH_DEFAULT,
      recent: 500, minRecent: 3, minLift: 2,
    });
  });

  it('keeps trace inside maxGraph and the graph inside its bound', () => {
    const limits = starLimits({ ...defaultStarSetup(), trace: 900, maxGraph: 700 });
    expect(limits.trace).toBe(700);
    expect(limits.maxGraph).toBe(700);
    expect(starLimits({ ...defaultStarSetup(), maxGraph: 99_999 }).maxGraph).toBe(5000);
  });
});

describe('resolveAliases', () => {
  it('follows a chain to the final tag and keeps its display text', () => {
    const resolved = resolveAliases({ js: 'JavaScript', javascript: 'ECMAScript' });
    expect(resolved.map.get('js')).toBe('ECMAScript');
    expect(resolved.map.get('javascript')).toBe('ECMAScript');
  });

  it('breaks a cycle with a note rather than looping', () => {
    const resolved = resolveAliases({ a: 'b', b: 'a' });
    expect(resolved.notes.some((n) => n.includes('cycle'))).toBe(true);
    expect(resolved.map.size).toBeLessThanOrEqual(2);
  });
});

describe('document rewrite', () => {
  it('replaces only the named section', () => {
    const md = setSection(STAR_TAGGER_DOC, 'Mapping', '### Web\n- react ↔ hooks ×2');
    expect(md).toContain('## Setup');
    expect(md).toContain('- react ↔ hooks ×2');
    expect(md).toContain('## Notes');
    expect(md).toContain('This row customizes the star');
  });

  it('sets one Setup key without touching the comments', () => {
    const md = setSetupValue(STAR_TAGGER_DOC, 'reset', 'no');
    expect(md).toContain('\nreset: no\n');
    expect(md).toContain('# reset: no');
  });
});

describe('starSetupFingerprint', () => {
  it('leaves reset out, so clearing it does not seed twice', () => {
    const setup = { ...defaultStarSetup(), base: 10 };
    expect(starSetupFingerprint({ ...setup, reset: true }))
      .toBe(starSetupFingerprint({ ...setup, reset: false }));
  });
});

describe('buildStarTaxonomy', () => {
  const rows = [row(1), row(2)];
  const reports = new Map([
    [1, report(1, [tagged('portfolioRisk', 0.9, 'bm25'), tagged('kelly_Ito', 0.4)], 3)],
    [2, report(2, [tagged('portfolioRisk', 0.7, 'textRank')], 3)],
  ]);
  const pins = [pin(['turnOver_Alpha'])];
  const graph = buildTagGraph(pins, rows, reports, { keepAliases: true, maxNodes: 1111 });

  it('writes the header, table columns and relation sections', () => {
    const setup = { ...defaultStarSetup(), trace: 555 };
    const seed = seedOf(graph, pins, rows, reports);
    const trace = buildStarTaxonomy(seed, setup, timing, new Date('2026-10-17T00:00:00Z'));
    expect(trace.text).toContain('seeded 2026-10-17T00:00:00.000Z');
    expect(trace.text).toContain('| tag | reach | kind | score | weight | freq | λ | burst | top | recent | base | lift | trend |');
    expect(trace.text).toContain('### Bursts');
    expect(trace.mapping).toContain('### Aliases');
    expect(trace.mapping).toContain('### Synonyms');
    expect(trace.mapping).toContain('### Themes');
    expect(trace.mapping).toContain('### Web');
    expect(trace.text).toContain('portfolioRisk');
    expect(trace.text).toContain('turnOver_Alpha');
    expect(trace.text).not.toContain('https://example.com/1');
    expect(trace.text).not.toContain('row 1');
    expect(trace.text).toContain('time: config 0ms');
  });

  it('skips a maintenance tag a report carries', () => {
    const dirty = new Map([
      [1, report(1, [tagged('portfolioRisk', 0.9, 'bm25'), tagged('FIXME_dup_ref', 0.8)])],
    ]);
    const dirtyGraph = buildTagGraph(pins, rows, dirty, { keepAliases: true, maxNodes: 1111 });
    const trace = buildStarTaxonomy(seedOf(dirtyGraph, pins, rows, dirty), defaultStarSetup(), timing);
    expect(trace.text).not.toContain('FIXME_dup_ref');
    expect(trace.mapping).not.toContain('FIXME_dup_ref');
  });

  it('cuts the table at trace and leaves the relation sections in place', () => {
    const setup = { ...defaultStarSetup(), trace: 1 };
    const seed = seedOf(graph, pins, rows, reports);
    const trace = buildStarTaxonomy(seed, setup, timing);
    expect(trace.nodes).toBe(1);
    expect(trace.text).toContain('trace cut at 1 of');
    expect(trace.mapping).toContain('### Web');
  });

  it('writes no table rows when trace is zero', () => {
    const setup = { ...defaultStarSetup(), trace: 0 };
    const trace = buildStarTaxonomy(seedOf(graph, pins, rows, reports), setup, timing);
    expect(trace.nodes).toBe(0);
    expect(trace.text).not.toContain('portfolioRisk |');
    expect(trace.text).toContain('### Bursts');
  });
});
