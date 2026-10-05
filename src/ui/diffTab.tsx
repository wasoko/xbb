/** Diff tab body: one row version — a discarded `cr` entry or a `ver` entry — against the text
 *  the row carries now, with one Apply button per changed region.
 *
 *  Mounted in the editor pane in place of the code editor under a `diff|…` ref, so the tab bar
 *  and the URL keep working. An apply writes the row through `daEdit`, drops the `cr` entry it
 *  came from, and refreshes the editor buffer through `onApplied`.
 */
import { useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { daEdit, daRead, db, dropCrEntry, stampTime, type Da, type VerHist } from '../sdb';
import { softGreet } from '../greet';
import { applyHunk, diffHunks, parseAnsi, type DiffHunk } from './diff';

export interface DiffTabProps {
  /** Row ref the version belongs to. */
  refName: string;
  /** History the version comes from. */
  source: 'ver' | 'cr';
  /** Key inside that history: a `ver` server `dt`, or a `cr` key of `devAgent` plus `modAt`. */
  stamp: string;
  /** Called with the new row text after an apply, so the editor buffer stays in step. */
  onApplied: (ref: string, txt: string) => void;
}

/** Drop one consumed `cr` entry, and with the last one the marker tag. */
async function dropCr(row: Da, key: string) {
  if (row.tid == null) return;
  await db.das.update(row.tid, dropCrEntry(row, key));
}

const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

/** One tab's diff. `row` is `undefined` while the live query resolves and `null` when the ref has
 *  no row at all. */
export function DiffTab({ refName, source, stamp, onApplied }: DiffTabProps) {
  const row = useLiveQuery(async () => (await daRead(refName)) ?? null, [refName]);
  const version = ((row?.rec?.[source] ?? {}) as VerHist)[stamp];
  const hunks = useMemo(() => (row && version ? diffHunks(version.txt ?? '', row.txt) : [])
    , [row, version]);

  if (row === undefined) return <div style={{ padding: 12, opacity: 0.7 }}>loading…</div>;
  if (row === null || !row.tid)
    return <div style={{ padding: 12, opacity: 0.7 }}>no row for {refName}</div>;

  const apply = async (hunk: DiffHunk) => {
    const next = applyHunk(row.txt, hunk);
    if (next.failed || next.txt === row.txt) return;
    await db.das.update(row.tid!, daEdit(row, next.txt));
    if (source === 'cr') await dropCr(row, stamp);
    onApplied(refName, next.txt);
    softGreet(); // the applied edit is a normal local edit: push it in the background
  };

  return (
    <div className="diff-tab" style={{ height: '100%', overflow: 'auto', padding: '8px 10px' }}>
      <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 6 }}>
        {source === 'cr' ? 'discarded local edit' : 'server version'}
        {` ${new Date(stampTime(stamp)).toLocaleString()} · ${refName} · `}
        <span style={{ color: '#f87171' }}>red = this version</span>
        {', '}
        <span style={{ color: '#4ade80' }}>green = now</span>
      </div>
      {version === undefined && (
        <div style={{ opacity: 0.7 }}>this version is no longer held on this client</div>
      )}
      {version !== undefined && hunks.length === 0 && (
        <div style={{ opacity: 0.7 }}>no differences — the row carries this text</div>
      )}
      {hunks.map((hunk, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '6px 0'
          , borderTop: '1px solid rgba(255,255,255,0.12)' }}>
          <pre style={{ flex: 1, margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word'
            , fontFamily: MONO, fontSize: 12, lineHeight: 1.45 }}>
            {parseAnsi(hunk.ansi).map((run, j) => (
              <span key={j} style={run.color
                ? { color: run.color === 'red' ? '#f87171' : '#4ade80' }
                : undefined}>{run.text}</span>
            ))}
          </pre>
          <button
            onClick={() => { void apply(hunk); }}
            title="write this version's wording for this region into the row"
            style={{ flex: '0 0 auto', fontSize: 11, padding: '2px 8px', cursor: 'pointer' }}
          >Apply</button>
        </div>
      ))}
    </div>
  );
}
