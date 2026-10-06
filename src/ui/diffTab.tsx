/** Diff tab body: one row version — a discarded `cr` entry or a `ver` entry — against the text
 *  the row carries now, with one Apply button per change: a region holding several changes is
 *  taken one change at a time.
 *
 *  Mounted in the editor pane in place of the code editor under a `diff|…` ref, so the tab bar
 *  and the URL keep working. An apply writes the row through `daEdit` and refreshes the editor
 *  buffer through `onApplied`; the `cr` entry stays until every change is applied or the tab
 *  discards it.
 */
import { useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { daEdit, daRead, db, dropHistEntry, stampTime, type VerHist } from '../sdb';
import { consumeConflict, softGreet } from '../greet';
import { applyHunk, diffHunks, parseAnsi, type DiffChange, type DiffHunk } from './diff';

export interface DiffTabProps {
  /** Row ref the version belongs to. */
  refName: string;
  /** History the version comes from. */
  source: 'ver' | 'cr';
  /** Key inside that history: a `ver` server `dt`, or a `cr` key of `devAgent` plus `modAt`. */
  stamp: string;
  /** Called with the new row text after an apply, so the editor buffer stays in step. */
  onApplied: (ref: string, txt: string) => void;
  /** Called after the entry is trashed, so the editor can close this tab. */
  onDiscarded?: (ref: string) => void;
}

const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

/** Coloured display of one ANSI diff string. */
function Ansi({ text }: { text: string }) {
  return (<>
    {parseAnsi(text).map((run, i) => (
      <span key={i} style={run.color
        ? { color: run.color === 'red' ? '#f87171' : '#4ade80' }
        : undefined}>{run.text}</span>
    ))}
  </>);
}

/** One tab's diff. `row` is `undefined` while the live query resolves and `null` when the ref has
 *  no row at all. */
export function DiffTab({ refName, source, stamp, onApplied, onDiscarded }: DiffTabProps) {
  const row = useLiveQuery(async () => (await daRead(refName)) ?? null, [refName]);
  const version = ((row?.rec?.[source] ?? {}) as VerHist)[stamp];
  const hunks = useMemo(() => (row && version ? diffHunks(version.txt ?? '', row.txt) : [])
    , [row, version]);

  if (row === undefined) return <div style={{ padding: 12, opacity: 0.7 }}>loading…</div>;
  if (row === null || !row.tid)
    return <div style={{ padding: 12, opacity: 0.7 }}>no row for {refName}</div>;

  /** Take one change of the version into the row; the entry stays for the changes left. */
  const apply = async (change: DiffChange | DiffHunk) => {
    const next = applyHunk(row.txt, change);
    if (next.failed || next.txt === row.txt) return;
    await db.das.update(row.tid!, daEdit(row, next.txt));
    onApplied(refName, next.txt);
    softGreet(); // the applied change is a normal local edit: push it in the background
  };

  /** Trash the entry itself: the text it held is dropped, not applied. */
  const discardEntry = async () => {
    await db.das.update(row.tid!, dropHistEntry(row, source, stamp));
    if (source === 'cr') consumeConflict({ ref: refName, stamp });
    onDiscarded?.(refName);
  };

  return (
    <div className="diff-tab" style={{ height: '100%', overflow: 'auto', padding: '8px 10px' }}>
      <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 6 }}>
        {source === 'cr' ? 'discarded local edit' : 'server version'}
        {` ${new Date(stampTime(stamp)).toLocaleString()} · ${refName} · `}
        <span style={{ color: '#f87171' }}>red = this version</span>
        {', '}
        <span style={{ color: '#4ade80' }}>green = now</span>
        {source === 'cr' && version !== undefined && hunks.length === 0 && (
          <button
            onClick={() => { void discardEntry(); }}
            title="trash this entry: the text it held is dropped for good"
            style={{ marginLeft: 8, fontSize: 11, padding: '2px 8px', cursor: 'pointer' }}
          >Discard this cr</button>
        )}
      </div>
      {version === undefined && (
        <div style={{ opacity: 0.7 }}>this version is no longer held on this client</div>
      )}
      {version !== undefined && hunks.length === 0 && (
        <div style={{ opacity: 0.7 }}>no differences — the row carries this text</div>
      )}
      {hunks.map((hunk, i) => (
        <div key={i} style={{ padding: '6px 0', borderTop: '1px solid rgba(255,255,255,0.12)' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
            <pre style={{ flex: 1, margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word'
              , fontFamily: MONO, fontSize: 12, lineHeight: 1.45, opacity: 0.85 }}>
              <Ansi text={hunk.ansi} />
            </pre>
            {hunk.changes.length === 1 && (
              <button
                onClick={() => { void apply(hunk.changes[0]); }}
                title="write this change's wording into the row"
                style={{ flex: '0 0 auto', fontSize: 11, padding: '2px 8px', cursor: 'pointer' }}
              >Apply</button>
            )}
          </div>
          {hunk.changes.length > 1 && hunk.changes.map((change, j) => (
            <div key={j} style={{ display: 'flex', alignItems: 'flex-start', gap: 8
              , padding: '4px 0 0 12px' }}>
              <pre style={{ flex: 1, margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word'
                , fontFamily: MONO, fontSize: 12, lineHeight: 1.45 }}>
                <Ansi text={change.ansi} />
              </pre>
              <button
                onClick={() => { void apply(change); }}
                title="write this change's wording into the row"
                style={{ flex: '0 0 auto', fontSize: 11, padding: '2px 8px', cursor: 'pointer' }}
              >Apply</button>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
