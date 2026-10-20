// @vitest-environment node
/**
 * srcfeedDoc.test.ts — the `*.feed.md` dialect: the `## Setup` a read obeys, the
 * `## Posts as of …` block it writes, and the `{ref}` token a pin card heading
 * carries into `cs1`.
 *
 * The write rules are the ones a refresh depends on, so they are asserted as the
 * document's own order: the newest block lands under `Setup`, the older ones keep
 * theirs, and `next:` moves without disturbing `freq:` or the sources.
 */

import { describe, expect, it } from 'vitest';
import { headingMatchRuns, splitHeadingParts } from '../../src/ui/cs1Token';
import {
  dueForRefresh, feedDraft, insertPosts, isFeedRef, latestPosts, nextRefreshAt, parseFreq,
  parsePostItem, parseStamp, parseWFeedDoc, postItem, postsBlock, setSetupValue,
} from '../../src/srcfeed';

/** A document with a schedule, prose, and one read behind it. */
const DOC = `# w.feed

## Setup
freq: 4hr
next:
sources: wallstreetcn, sina-fly51fly

## Notes
what the user wrote

## Posts as of 2026-10-16T03:00:00Z
- **wallstreetcn** older — https://wallstreetcn.com/livenews/1
`;

const at = (text: string) => new Date(text).getTime();

describe('parseWFeedDoc', () => {
  it('reads the schedule out of ## Setup', () => {
    const { setup } = parseWFeedDoc(DOC);
    expect(setup.freqText).toBe('4hr');
    expect(setup.freqMs).toBe(4 * 3_600_000);
    expect(setup.nextText).toBe('');
    expect(setup.nextAt).toBeNull();
    expect(setup.sources).toEqual(['wallstreetcn', 'sina-fly51fly']);
  });

  it('keeps the posts blocks in written order, with the headings own stamps', () => {
    const doc = parseWFeedDoc(`${DOC}\n## Posts as of 2026-10-16T07:00:00Z\n- newer\n`);
    expect(doc.posts).toHaveLength(2);
    expect(doc.posts[0].items).toEqual([postItem('wallstreetcn', 'older', 'https://wallstreetcn.com/livenews/1')]);
    expect(doc.posts[1].asOf?.toISOString()).toBe('2026-10-16T07:00:00.000Z');
    expect(latestPosts(doc)?.asOf?.toISOString()).toBe('2026-10-16T07:00:00.000Z');
  });

  it('keeps a document with no Setup readable', () => {
    const doc = parseWFeedDoc('# w.feed\n');
    expect(doc.setup.freqMs).toBe(0);
    expect(doc.posts).toEqual([]);
    expect(nextRefreshAt(doc)).toBeNull();
  });
});

describe('freq and stamps', () => {
  it('reads the units a freq may be written in', () => {
    expect(parseFreq('4hr')).toBe(4 * 3_600_000);
    expect(parseFreq('30 min')).toBe(1_800_000);
    expect(parseFreq('2d')).toBe(2 * 86_400_000);
    expect(parseFreq('auto')).toBe(0);
  });

  it('reads a stamp out of a heading, and refuses text that is not one', () => {
    expect(parseStamp('Posts as of 2026-10-16T07:00:00Z')?.toISOString())
      .toBe('2026-10-16T07:00:00.000Z');
    expect(parseStamp('4hr')).toBeNull();
    expect(parseStamp('')).toBeNull();
  });
});

describe('the next read', () => {
  it('takes `next:` as written when the document names one', () => {
    const doc = parseWFeedDoc(DOC.replace('next:\n', 'next: 2026-10-16T11:00:00Z\n'));
    expect(nextRefreshAt(doc)?.toISOString()).toBe('2026-10-16T11:00:00.000Z');
    expect(dueForRefresh(doc, new Date('2026-10-16T10:59:00Z'))).toBe(false);
    expect(dueForRefresh(doc, new Date('2026-10-16T11:00:00Z'))).toBe(true);
  });

  it('derives one from freq and the newest block when `next:` is empty', () => {
    const doc = parseWFeedDoc(DOC);
    expect(nextRefreshAt(doc)?.toISOString()).toBe('2026-10-16T07:00:00.000Z');
    expect(dueForRefresh(doc, new Date('2026-10-16T06:59:00Z'))).toBe(false);
    expect(dueForRefresh(doc, new Date('2026-10-16T07:00:00Z'))).toBe(true);
  });

  it('never calls a document with no freq and no next due', () => {
    const doc = parseWFeedDoc('# w.feed\n\n## Setup\nsources: a\n');
    expect(nextRefreshAt(doc)).toBeNull();
    expect(dueForRefresh(doc, new Date())).toBe(false);
  });
});

describe('writing a read', () => {
  it('puts the block under Setup and keeps the older ones', () => {
    const next = insertPosts(DOC, postsBlock(new Date('2026-10-16T07:00:00Z'),
      [postItem('wallstreetcn', 'newer', 'https://wallstreetcn.com/livenews/2')]));
    expect(next.indexOf('## Posts as of 2026-10-16T07:00:00.000Z')).toBeGreaterThan(next.indexOf('freq: 4hr'));
    expect(next.indexOf('## Posts as of 2026-10-16T07:00:00.000Z')).toBeLessThan(next.indexOf('## Notes'));
    expect(next.indexOf('## Posts as of 2026-10-16T03:00:00Z')).toBeGreaterThan(next.indexOf('## Notes'));
    expect(next).toContain('- **wallstreetcn** newer — https://wallstreetcn.com/livenews/2');
  });

  it('appends the block when Setup is the last section', () => {
    const fresh = '# w.feed\n\n## Setup\nfreq: 4hr\nnext:\n';
    const next = insertPosts(fresh, postsBlock(new Date('2026-10-16T07:00:00Z'), ['- one']));
    expect(next.trimEnd().endsWith('- one')).toBe(true);
    expect(parseWFeedDoc(next).posts[0].items).toEqual(['- one']);
  });

  it('moves `next:` without touching the rest of Setup', () => {
    const next = setSetupValue(DOC, 'next', '2026-10-16T11:00:00Z');
    expect(next).toContain('next: 2026-10-16T11:00:00Z');
    expect(next).not.toContain('next:\n');
    expect(next).toContain('freq: 4hr');
    expect(next).toContain('sources: wallstreetcn, sina-fly51fly');
  });

  it('adds the key when Setup does not carry it', () => {
    const next = setSetupValue('# w.feed\n\n## Setup\nfreq: 4hr\n', 'next', '2026-10-16T11:00:00Z');
    expect(next).toContain('## Setup\nnext: 2026-10-16T11:00:00Z\nfreq: 4hr');
  });

  it('writes the section when the document has none', () => {
    const next = setSetupValue('# w.feed\n', 'next', '2026-10-16T11:00:00Z');
    expect(next).toContain('## Setup\nnext: 2026-10-16T11:00:00Z');
  });

  it('round-trips an item line through the readout', () => {
    expect(parsePostItem(postItem('wallstreetcn', 'a — b', 'https://a.test/1')))
      .toEqual({ source: 'wallstreetcn', text: 'a — b', ref: 'https://a.test/1' });
    expect(parsePostItem('plain prose')).toBeNull();
  });
});

describe('the ref a feed document lives under', () => {
  it('takes any `.feed.md`, whatever it is called', () => {
    expect(isFeedRef('w.feed.md')).toBe(true);
    expect(isFeedRef('my.news.feed.md')).toBe(true);
    expect(isFeedRef('MY.FEED.MD')).toBe(true);
    expect(isFeedRef('feed.md')).toBe(false);
    expect(isFeedRef('pin_feed.md')).toBe(false);
  });

  it('opens a missing ref on the template, titled after the ref', () => {
    const draft = feedDraft('my.feed.md');
    expect(draft.startsWith('# my.feed\n')).toBe(true);
    const doc = parseWFeedDoc(draft);
    expect(doc.setup.freqText).toBe('2hr');
    expect(doc.setup.nextText).toBe('');
    // No named source reads every entry without a `Src:` row, whatever they are called.
    expect(doc.setup.sources).toEqual([]);
    expect(doc.posts).toEqual([]);
    expect(nextRefreshAt(doc)).toBeNull();
  });
});

describe('{ref} tokens in a pin card heading', () => {
  it('splits tags and refs away from the runs between them', () => {
    expect(splitHeadingParts('plan {w.feed.md} #tag')).toEqual([
      { text: 'plan ' }, { ref: 'w.feed.md' }, { text: ' ' }, { tag: 'tag' },
    ]);
  });

  it('leaves a brace pair with whitespace in it as text', () => {
    expect(splitHeadingParts('a {not a ref} b')).toEqual([{ text: 'a {not a ref} b' }]);
  });
});

describe('heading match runs', () => {
  it('leaves the run with the heading that added the tag, not the headings under it', () => {
    // `# head1 #webfeed` / `## head2` / `## head3`: one H1 group, one run of rows.
    expect(headingMatchRuns([['webfeed'], [], []])).toEqual([
      { path: ['webfeed'], added: ['webfeed'] },
      { path: ['webfeed'], added: [] },
      { path: ['webfeed'], added: [] },
    ]);
  });

  it('narrows the path for a tagged heading and never repeats a tag', () => {
    expect(headingMatchRuns([['webfeed'], ['sports'], ['sports']])).toEqual([
      { path: ['webfeed'], added: ['webfeed'] },
      { path: ['webfeed', 'sports'], added: ['sports'] },
      { path: ['webfeed', 'sports'], added: [] },
    ]);
  });
});
