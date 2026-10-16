// @vitest-environment happy-dom
/**
 * WFeedTip.test.ts — the feed readout as markup, with its live queries stubbed.
 *
 * The body reads two rows (`w.feed.md` and `webfeed.md`) through `useLiveQuery`, so the
 * hook is mocked and each case pushes the pair the body should see. That is what lets the
 * branches a real store reaches only after a query lands — a ref with no row yet, a
 * `## Setup` naming a block `webfeed.md` does not declare, a config still being read — be
 * rendered and asserted here, which is where a reference to a name that does not exist
 * would otherwise crash the preview at runtime.
 */

import 'fake-indexeddb/auto';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Da } from '../src/sdb';
import { W_FEED_DOC } from '../src/webfeedRows';

/** One value per `useLiveQuery` call of a render: the feed row first, the config second. */
const queue = vi.hoisted(() => [] as unknown[]);

vi.mock('dexie-react-hooks', () => ({ useLiveQuery: () => queue.shift() }));

const { WFeedTip } = await import('../src/ui/WFeedTip');

/** A row carrying `txt`. */
const row = (txt: string, ref: string): Da => ({ ref, type: 'md', txt, rec: {} });

/** The config a seeded table holds: one `wallstreetcn` block. */
const CONFIG = row(`# Feeds

## Sources

### wallstreetcn
* URL: https://wallstreetcn.com/live/global
`, 'webfeed.md');

beforeEach(() => {
  queue.length = 0;
});

describe('WFeedTip', () => {
  it('shows the template a ref with no row yet will open on', () => {
    queue.push({ row: undefined }, { row: CONFIG });
    const html = renderToStaticMarkup(<WFeedTip feedRef="probe.feed.md" />);
    expect(html).toContain('probe.feed.md');
    expect(html).toContain('no row yet — the editor opens on this template');
    expect(html).toContain('2hr');
    expect(html).toContain('wallstreetcn.com');
  });

  it('names the sources a document asks for that webfeed.md does not declare', () => {
    const doc = W_FEED_DOC.replace(/^sources:.*$/m, 'sources: wallstreetcn, gone');
    queue.push({ row: row(doc, 'probe.feed.md') }, { row: CONFIG });
    const html = renderToStaticMarkup(<WFeedTip feedRef="probe.feed.md" />);
    expect(html).toContain('not in webfeed.md: gone');
    expect(html).toContain('wallstreetcn.com');
  });

  it('says which list it is still reading while the config query runs', () => {
    queue.push(null, null);
    const html = renderToStaticMarkup(<WFeedTip feedRef="probe.feed.md" />);
    expect(html).toContain('reading webfeed.md…');
    expect(html).not.toContain('no row yet');
  });

  it('shows the stored items of the newest block', () => {
    const doc = `${W_FEED_DOC}
## Posts as of 2026-10-16T07:00:00Z

- **wallstreetcn** 央行… — https://wallstreetcn.com/livenews/42
`;
    queue.push({ row: row(doc, 'probe.feed.md') }, { row: CONFIG });
    const html = renderToStaticMarkup(<WFeedTip feedRef="probe.feed.md" />);
    expect(html).toContain('央行…');
    expect(html).toContain('https://wallstreetcn.com/livenews/42');
    expect(html).toContain('1 item(s)');
  });
});
