/**
 * restHelp.test.ts — the hover text the rest tuner and the rest panel carry.
 *
 * The strings are prose, so the assertions are structural rather than textual:
 * every grouper, reading, window mode and channel has a line, no tuner control's
 * line is blank, and only a family that does not score the trie itself gets the
 * `keywords` caveat. The grouper keys are checked against `REST_PROFILES` rather
 * than listed here, so a renamed ref fails instead of drifting.
 */

import 'fake-indexeddb/auto';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TAG_CHANNEL_LABEL, type TagParts } from '../src/srctag';
import { REST_PROFILES, RRF_GROUPER, REST_VIZ_MODES, REST_WINDOW_MODES, RSFREQ_GROUPER, RSTT_GROUPER } from '../src/ui/restGrouper';
import {
  CHANNEL_HELP, knobHelp, knobLabel, PROFILE_HELP, TUNER_HELP, VIZ_HELP, vizCaveat, WINDOW_HELP,
} from '../src/ui/restHelp';
import { RestTuner } from '../src/ui/restTuner';
import { RestViz } from '../src/ui/restViz';

describe('restHelp', () => {
  it('names every grouper the profiles offer, and only those', () => {
    expect(Object.keys(PROFILE_HELP).sort()).toEqual(Object.keys(REST_PROFILES).sort());
  });

  it('explains every reading and every window the tuner offers', () => {
    for (const option of REST_VIZ_MODES) expect(VIZ_HELP[option.value], option.value).toBeTruthy();
    for (const option of REST_WINDOW_MODES) expect(WINDOW_HELP[option.value], option.value).toBeTruthy();
  });

  it('explains every channel knob, under the label the tuner renders', () => {
    for (const key of Object.keys(TAG_CHANNEL_LABEL) as (keyof TagParts)[]) {
      expect(knobHelp(key), key).toBeTruthy();
      expect(knobLabel(key)).toBe(TAG_CHANNEL_LABEL[key]);
      expect(CHANNEL_HELP[key], key).toBeTruthy();
    }
  });

  it('leaves no tuner control without a line', () => {
    for (const [name, help] of Object.entries(TUNER_HELP)) expect(help, name).toBeTruthy();
  });

  it('caveats the keyword reading exactly where the keyword weight is off', () => {
    expect(vizCaveat('keywords', { keyword: 0 })).toMatch(/keyword/);
    expect(vizCaveat('keywords', { keyword: 1 })).toBeUndefined();
    // only the reading that needs the weight carries the note
    for (const mode of ['chips', 'priority', 'themes', 'channels'] as const) {
      expect(vizCaveat(mode, { keyword: 0 }), mode).toBeUndefined();
    }
  });
});

/** The rendered strip and panel, so the prose is checked where the reader meets it. */
describe('restHelp in the UI', () => {
  /** React escapes `'`, `"` and `&` in attribute text; the prose is compared plain. */
  const markup = (el: React.ReactElement): string => renderToStaticMarkup(el)
    .replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');

  it('titles every tuner control and both selects\' options', () => {
    const html = markup(React.createElement(RestTuner, { grouper: RSFREQ_GROUPER, onChange: () => {} }));
    // the knobs this family scores with carry their own channel line
    expect(html).toContain('a word rare in the burst scores higher');
    expect(html).toContain('the lift a curated tag gets');
    // the cut-off's line names the control that thins a chip list, and the
    // minLength note stays reachable from the reading, which every family draws
    expect(html).toContain('use `topK` to shorten the list');
    expect(html).toContain('minLen');
    // option-level help: the reading and the window each explain themselves in the list
    for (const option of REST_VIZ_MODES) expect(html, option.value).toContain(VIZ_HELP[option.value]);
    for (const option of REST_WINDOW_MODES) expect(html, option.value).toContain(WINDOW_HELP[option.value]);
  });

  it('marks the keyword reading as beside the point for a TF-IDF family', () => {    const html = markup(React.createElement(RestTuner, {
      grouper: RSFREQ_GROUPER, hyper: { viz: 'keywords' }, onChange: () => {},
    }));
    expect(html).toContain('only lifts a curated tag here');
    const trie = markup(React.createElement(RestTuner, {
      grouper: RSTT_GROUPER, hyper: { viz: 'keywords' }, onChange: () => {},
    }));
    expect(trie).not.toContain('only lifts a curated tag here');
  });

  it('draws the same caveat on the panel, for the family on screen only', () => {    const panel = (grouper: string) => markup(React.createElement(RestViz, {
      grouper, mode: 'keywords', rows: [], reports: new Map(),
    }));
    expect(panel(RSFREQ_GROUPER)).toContain('leaves the `keyword` weight off');
    expect(panel(RSTT_GROUPER)).not.toContain('leaves the `keyword` weight off');
  });

  it('strips the rrf grouper with its per-stage knobs and its own profile line', () => {
    const html = markup(React.createElement(RestTuner, { grouper: RRF_GROUPER, onChange: () => {} }));
    expect(html).toContain(PROFILE_HELP[RRF_GROUPER]);
    for (const label of ['k1', 'rrf k', 'mmr λ', 'graph λ', 'max df', 'stop']) expect(html, label).toContain(label);
    // the BM25F field weights are three boxes of their own, and the BM25F list is
    // one of the weights this family scores with, under its own channel line
    for (const field of ['w title', 'w url', 'w tags']) expect(html, field).toContain(field);
    expect(html).toContain('outranks the same word in a URL');
    // the stop box carries the shipped function words, so a reader can see what
    // is already dropped before adding to it
    expect(html).toContain('vs versus how why what when');
  });
});
