/**
 * FeedTip.tsx — the hover preview a pin card's `{*.feed.md}` token shows.
 *
 * The token is a ref, so its preview is the row's own feed: when the next read is due
 * and at what frequency, which `srcfeed.md` entries it reads and from which host, and
 * the items the last read stored. The `refresh` button runs one read now
 * (`src/srcfeed.ts`); a document whose `next` has already passed is read once by
 * itself when the preview opens, so a stale feed catches up as soon as it is looked at.
 * A Bilibili read that needs the account shows a QR login button in the webapp and
 * the passport link in the extension.
 *
 * The body reads the row through a live query, so the read's own write lands back in
 * the preview without anyone passing the result along.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { toast } from 'sonner';
import { cleanDomain, fmtAgo } from '../fc';
import { BB_LOGIN_URL, BB_SIGNIN_HINT, hasBbFetch } from '../bb';
import { signinGoogle } from '../greet';
import { daRead, type Da } from '../sdb';
import {
  feedDraft, isFeedRef, latestPosts, loadSrcRegistry, nextRefreshAt, parseWFeedDoc,
  reportLine, runSrcFeed, storedItems, untilText,
  type SrcFeedItem, type SrcFeedReport,
} from '../srcfeed';
import { sdbSrcFeedStore } from '../srcfeedStore';
import { openBbLogin, useBbLoginVersion } from './bbLogin';

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
const LINK_BUTTON: React.CSSProperties = {
  ...ITEM_REF, padding: 0, border: 0, background: 'transparent', fontSize: 12,
  fontFamily: 'inherit', cursor: 'pointer',
};
const BUTTON: React.CSSProperties = {
  marginTop: 6, padding: '2px 8px', fontSize: 12, borderRadius: 4, cursor: 'pointer',
  background: 'rgba(255,255,255,0.08)', color: 'inherit',
  border: '1px solid rgba(255,255,255,0.3)',
};

/**
 * The feed readout of one `*.feed.md`.
 *
 * @param props.feedRef - the ref the preview belongs to; `w.feed.md` unless a document
 *   of the same dialect is pointed at under another name
 * @returns the schedule, the sources read, the stored items, and a refresh control
 */
export function FeedTip({ feedRef }: { feedRef: string }) {
  /* `null` while the row has not been read, so an absent row is told from a pending read. */
  const held = useLiveQuery(async () => ({ row: await daRead(feedRef) }), [feedRef], null);
  /* Same sentinel for the registry: it is what says whether the entries below are still
     being read or are simply not there. */
  const config = useLiveQuery(async () => ({ registry: await loadSrcRegistry(sdbSrcFeedStore()) }), [], null);
  const [report, setReport] = useState<SrcFeedReport | null>(null);
  const [busy, setBusy] = useState(false);
  const loginVersion = useBbLoginVersion();

  const row: Da | undefined = held?.row;
  /* A ref with no row yet is read through the template it opens with, so the preview says
     what the document will be — 2hr, its default source, nothing read — before it exists. */
  const missing = held !== null && row === undefined;
  const source = row?.txt ?? (isFeedRef(feedRef) ? feedDraft(feedRef) : '');
  const doc = useMemo(() => parseWFeedDoc(source), [source]);
  const items: SrcFeedItem[] = useMemo(() => storedItems(doc), [doc]);
  /* Hosts come from `srcfeed.md`, so the readout can name where items are read from even
     before this document has been read once. */
  const hosts = useMemo(
    () => (config?.registry.entries ?? [])
      .map((entry) => ({
        name: entry.name,
        host: entry.url ? cleanDomain(entry.url) : '',
        src: entry.src,
      })),
    [config],
  );
  const last = latestPosts(doc);
  const at = nextRefreshAt(doc);
  const due = at !== null && Date.now() >= at.getTime();

  const read = useCallback(async () => {
    setBusy(true);
    try {
      setReport(await runSrcFeed({ ref: feedRef, now: new Date(), store: sdbSrcFeedStore() }));
    } finally {
      setBusy(false);
    }
  }, [feedRef]);

  /* The QR dialog closes only after a successful scan. A preview that was open
     while that happened reruns the same read, so the new cookie is used without
     another click. */
  useEffect(() => {
    if (loginVersion === 0) return;
    void read();
  }, [loginVersion, read]);

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

  /* The entries `## Setup` names: the ones `srcfeed.md` declares, and the ones it does not,
     which the line below reports by name rather than silently reading nothing. An empty
     `sources:` reads only entries without a `Src:` row, so the readout lists exactly those,
     not every adapter the registry happens to hold. */
  const chosen = doc.setup.sources;
  const named = chosen.length === 0
    ? hosts.filter((h) => h.src === '')
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
  const loginNeeded = report?.notes.some((note) => note.includes('passport.bilibili.com/login')) ?? false;
  const signInNeeded = report?.notes.some((note) => note.includes(BB_SIGNIN_HINT)) ?? false;

  const signIn = useCallback(async () => {
    try {
      const [, error] = await signinGoogle();
      if (error) toast.error(error);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }, []);

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
          ? <span style={KEY}>reading srcfeed.md…</span>
          : (
            <span style={KEY}>
              {chosen.length > 0
                ? `${chosen.join(', ')} not in srcfeed.md (it declares ${hosts.map((h) => h.name).join(', ') || 'no entry'})`
                : 'no source without a Src row; name one in sources:'}
            </span>
          ))}
        {missingSources.length > 0 && named.length > 0 && (
          <span style={KEY}>· not in srcfeed.md: {missingSources.join(', ')}</span>
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
        {loginNeeded && (hasBbFetch()
          ? (
            <button type="button" style={LINK_BUTTON} onClick={() => openBbLogin()}>
              bilibili QR login
            </button>
          )
          : (
            <a href={BB_LOGIN_URL} target="_blank" rel="noreferrer" style={{ ...ITEM_REF, fontSize: 12 }}>
              bilibili login
            </a>
          ))}
        {signInNeeded && (
          <button type="button" style={LINK_BUTTON} onClick={() => void signIn()}>
            sign in to webapp
          </button>
        )}
        {report === null && !busy && doc.setup.freqText === '' && (
          <span style={{ ...KEY, fontSize: 12 }}>no freq, so nothing reads on its own</span>
        )}
      </div>
    </div>
  );
}
