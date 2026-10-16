/**
 * WFeedTip.tsx — the hover preview a pin card's `{w.feed.md}` token shows.
 *
 * The token is a ref, so its preview is the row's own feed: when the next read is due
 * and at what frequency, which `webfeed.md` blocks it reads and from which host, and
 * the few newest items the last read stored. The `refresh` button runs one read now
 * (`ui/wFeedRun.ts`); a document whose `next` has already passed is read once by
 * itself when the preview opens, so a stale feed catches up as soon as it is looked at.
 *
 * The body reads the row through a live query, so the read's own write lands back in
 * the preview without anyone passing the result along.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { cleanDomain, fmtAgo } from '../fc';
import { daRead, type Da } from '../sdb';
import { isFeedRef, latestPosts, nextRefreshAt, parseWFeedDoc } from '../wFeed';
import { parseWebfeedDoc } from '../webfeed';
import { feedDraft } from '../webfeedRows';
import {
  reportLine, runWFeedRefresh, storedItems, untilText,
  type WFeedItem, type WFeedRunReport,
} from './wFeedRun';

/** Items the preview lists; the block itself keeps more. */
const TIP_ITEMS = 5;

/** One open preview reads a due document at most once per window, so a document that
 *  keeps failing does not retry on every hover. */
const AUTO_WINDOW_MS = 5 * 60_000;

/** When each ref was last read on its own, so the retry window survives a closed tip. */
const autoReadAt = new Map<string, number>();

const LINE: React.CSSProperties = { opacity: 0.85, marginBottom: 4 };
const KEY: React.CSSProperties = { opacity: 0.55 };
const ITEM: React.CSSProperties = {
  display: 'flex', gap: 6, alignItems: 'baseline', whiteSpace: 'nowrap', overflow: 'hidden',
};
const ITEM_REF: React.CSSProperties = { color: '#7ab8ff', textDecoration: 'underline' };
const BUTTON: React.CSSProperties = {
  marginTop: 6, padding: '2px 8px', fontSize: 12, borderRadius: 4, cursor: 'pointer',
  background: 'rgba(255,255,255,0.08)', color: 'inherit',
  border: '1px solid rgba(255,255,255,0.3)',
};

/**
 * The feed readout of one `w.feed.md`.
 *
 * @param props.feedRef - the ref the preview belongs to; `w.feed.md` unless a document
 *   of the same dialect is pointed at under another name
 * @returns the schedule, the sources read, the stored items, and a refresh control
 */
export function WFeedTip({ feedRef }: { feedRef: string }) {
  /* `null` while the row has not been read, so an absent row is told from a pending read. */
  const held = useLiveQuery(async () => ({ row: await daRead(feedRef) }), [feedRef], null);
  /* Same sentinel for the config: it is what says whether the blocks below are still
     being read or are simply not there. */
  const config = useLiveQuery(async () => ({ row: await daRead('webfeed.md', 'md') }), [], null);
  const [report, setReport] = useState<WFeedRunReport | null>(null);
  const [busy, setBusy] = useState(false);

  const row: Da | undefined = held?.row;
  /* A ref with no row yet is read through the template it opens with, so the preview says
     what the document will be — 2hr, its default source, nothing read — before it exists. */
  const missing = held !== null && row === undefined;
  const source = row?.txt ?? (isFeedRef(feedRef) ? feedDraft(feedRef) : '');
  const doc = useMemo(() => parseWFeedDoc(source), [source]);
  const items: WFeedItem[] = useMemo(() => storedItems(doc), [doc]);
  /* Hosts come from `webfeed.md`, so the readout can name where items are read from even
     before this document has been read once. */
  const hosts = useMemo(
    () => (config?.row?.txt
      ? parseWebfeedDoc(config.row.txt).sources
        .map((s) => ({ name: s.name, host: s.url ? cleanDomain(s.url) : '' }))
      : []),
    [config?.row?.txt],
  );
  const last = latestPosts(doc);
  const at = nextRefreshAt(doc);
  const due = at !== null && Date.now() >= at.getTime();

  const read = useCallback(async () => {
    setBusy(true);
    try {
      setReport(await runWFeedRefresh({ ref: feedRef, now: new Date() }));
    } finally {
      setBusy(false);
    }
  }, [feedRef]);

  /* A due document reads itself once when the preview opens; the window keeps a document
     whose source keeps refusing from asking again on every hover. */
  const pending = held === null;
  useEffect(() => {
    if (pending || !due) return;
    const tried = autoReadAt.get(feedRef) ?? 0;
    if (Date.now() - tried < AUTO_WINDOW_MS) return;
    autoReadAt.set(feedRef, Date.now());
    void read();
  }, [pending, due, feedRef, read]);

  /* The blocks `## Setup` names: the ones `webfeed.md` declares, and the ones it does not,
     which the line below reports by name rather than silently reading nothing. */
  const chosen = doc.setup.sources;
  const named = chosen.length === 0
    ? hosts
    : hosts.filter((h) => chosen.includes(h.name));
  const missingSources = chosen.filter((name) => !hosts.some((h) => h.name === name));
  const shown = items.slice(0, TIP_ITEMS);
  const sourceOf = (feed: string) => hosts.find((h) => h.name === feed)?.host || feed;

  /*
   * The three lines a read is judged by: what frequency it keeps, when the next one is
   * due, and what the last one left behind.
   */
  const nextText = at === null
    ? (doc.setup.nextText || '—')
    : `${at.toISOString()} (${due ? 'due' : `in ${untilText(at.getTime() - Date.now())}`})`;
  const lastText = last === undefined
    ? 'nothing read yet'
    : `${fmtAgo(last.asOf?.getTime())} · ${last.items.length} item(s)`;

  return (
    <div style={{ minWidth: 320 }}>
      <div style={{ ...LINE, marginBottom: 6 }}>
        <span style={KEY}>feed </span>{feedRef}
        {missing && <span style={KEY}> · no row yet — the editor opens on this template</span>}
        <span style={KEY}> · freq </span>{doc.setup.freqText || '—'}
        <span style={KEY}> · next </span>{nextText}
      </div>
      <div style={LINE}>
        <span style={KEY}>reads </span>
        {named.length > 0 && named.map((h) => (
          <span key={h.name} style={{ marginRight: 6 }}>
            {h.host || h.name}
            {h.host && h.host !== h.name ? <span style={KEY}> ({h.name})</span> : null}
          </span>
        ))}
        {named.length === 0 && (config === null
          ? <span style={KEY}>reading webfeed.md…</span>
          : (
            <span style={KEY}>
              {chosen.length > 0
                ? `${chosen.join(', ')} not in webfeed.md (it declares ${hosts.map((h) => h.name).join(', ') || 'no block'})`
                : 'webfeed.md declares no source'}
            </span>
          ))}
        {missingSources.length > 0 && named.length > 0 && (
          <span style={KEY}>· not in webfeed.md: {missingSources.join(', ')}</span>
        )}
      </div>
      <div style={LINE}>
        <span style={KEY}>last read </span>{lastText}
      </div>
      {shown.map((item) => (
        <div key={`${item.feed}\u0000${item.ref}`} style={ITEM} title={`${item.text}\n${item.ref}`}>
          <span style={{ ...KEY, flex: '0 0 auto' }}>{sourceOf(item.feed)}</span>
          <span style={{ flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {item.text}
          </span>
          {/^https?:/.test(item.ref)
            ? <a href={item.ref} target="_blank" rel="noreferrer" style={ITEM_REF}>open</a>
            : null}
        </div>
      ))}
      {items.length > shown.length && (
        <div style={{ ...LINE, ...KEY }}>+{items.length - shown.length} more in the block</div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button type="button" style={BUTTON} disabled={busy} onClick={() => void read()}>
          {busy ? 'reading…' : 'refresh'}
        </button>
        {report !== null && <span style={{ ...KEY, fontSize: 12 }}>{reportLine(report)}</span>}
        {report === null && !busy && doc.setup.freqText === '' && (
          <span style={{ ...KEY, fontSize: 12 }}>no freq, so nothing reads on its own</span>
        )}
      </div>
    </div>
  );
}
