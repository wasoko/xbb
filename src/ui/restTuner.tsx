// src/ui/restTuner.tsx
import React, { useState } from 'react';
import { DEFAULT_TAG_AIM, DEFAULT_TEXTRANK, DEFAULT_TRIE, TAG_CHANNEL_LABEL } from '../srctag';
import {
  REST_PROFILES, REST_VIZ_MODES, REST_WINDOW_MODES, restAim, restDynCapable, restHyperScore, restVizMode,
  type RestHyper, type RestTagProfile,
} from './restGrouper';

const BAR: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 8,
  padding: '3px 6px',
  borderBottom: '1px dashed rgba(255,255,255,0.14)',
};

const FIELD: React.CSSProperties = {
  background: 'transparent',
  border: '1px solid rgba(255,255,255,0.18)',
  borderRadius: 3,
  color: 'inherit',
  fontSize: '0.75em',
  padding: '0 3px',
  width: 56,
};

const LABEL: React.CSSProperties = { opacity: 0.55, fontSize: '0.75em' };

const ROW: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 3 };

const BUTTON: React.CSSProperties = {
  ...FIELD,
  width: 'auto',
  cursor: 'pointer',
  background: 'transparent',
};

/**
 * One editable number. The box keeps the caller's own text while it has focus, so
 * a half-typed `0.` is not overwritten by the committed value; anything that
 * already parses is committed on the keystroke, which is what makes the list
 * re-score as the knob moves.
 */
function Num({ label, value, onCommit }: {
  label: string; value: number; onCommit: (n: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <label style={ROW}>
      <span style={LABEL}>{label}</span>
      <input
        type="text" inputMode="decimal" value={draft ?? String(value)}
        onChange={(e) => {
          setDraft(e.target.value);
          const n = Number(e.target.value);
          if (e.target.value.trim() !== '' && Number.isFinite(n)) onCommit(n);
        }}
        onBlur={() => setDraft(null)}
        style={FIELD}
      />
    </label>
  );
}

/** One checkbox bound to a boolean knob. */
function Flag({ label, value, onCommit }: {
  label: string; value: boolean; onCommit: (v: boolean) => void;
}) {
  return (
    <label style={ROW}>
      <input type="checkbox" checked={value} onChange={(e) => onCommit(e.target.checked)} />
      <span style={LABEL}>{label}</span>
    </label>
  );
}

/** One select bound to a string knob. */
function Pick<T extends string>({ label, value, options, onCommit }: {
  label: string; value: T; options: { value: T; label: string }[]; onCommit: (v: T) => void;
}) {
  return (
    <label style={ROW}>
      <span style={LABEL}>{label}</span>
      <select value={value} onChange={(e) => onCommit(e.target.value as T)}
        style={{ ...FIELD, width: 'auto' }}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
}

export interface RestTunerProps {
  /** Ref of the active algorithm grouper; `REST_PROFILES` decides whether anything renders. */
  grouper: string;
  /** Live override, or undefined while the profile's defaults are in use. */
  hyper?: RestHyper;
  /** Replaces the override; `{}` restores the profile. */
  onChange: (hyper: RestHyper) => void;
}

/**
 * The hyperparameter strip the tag groupers render above their blocks. Every
 * value lives in the caller's component state, so an experiment costs a
 * keystroke and a reload restores the {@link RestTagProfile} defaults.
 *
 * The viz switch is the first control because it changes what the list is
 * telling the reader at all: `chips` is the tag layer beside the rows, and every
 * other reading draws the family's own characteristic — the channels it weighs,
 * the curated tags it reaches, the themes a burst shares, or the trie's forms —
 * in place of the `rsdt` blocks where that reading does not inform them.
 *
 * @param props.grouper - ref of the active grouper.
 * @param props.hyper - live override.
 * @param props.onChange - receives the replacement override.
 * @returns The strip, or nothing when the grouper has no profile.
 */
export function RestTuner({ grouper, hyper, onChange }: RestTunerProps) {
  const profile: RestTagProfile | undefined = REST_PROFILES[grouper];
  if (!profile) return null;

  const effective = restHyperScore(profile, hyper);
  const rank = { ...DEFAULT_TEXTRANK, ...profile.rank, ...hyper?.rank };
  const trie = { ...DEFAULT_TRIE, ...profile.trie, ...hyper?.trie };
  const mode = hyper?.mode ?? profile.mode;
  const viz = restVizMode(profile, hyper);
  const aim = restAim(profile, hyper) !== false;
  const patch = (p: RestHyper) => onChange({ ...hyper, ...p });

  return (
    <div className="rest-hyper" style={BAR}>
      <span style={LABEL}>{grouper}</span>
      <Pick label="viz" value={viz} options={REST_VIZ_MODES}
        onCommit={(v) => patch({ viz: v })} />
      <Flag label="aim" value={aim} onCommit={(v) => patch({ aim: v })} />
      {aim && (
        <>
          <Num label="aimMin" value={hyper?.aimMin ?? 0.4}
            onCommit={(n) => patch({ aimMin: n })} />
          <Num label="promote ≥" value={hyper?.promoteMin ?? DEFAULT_TAG_AIM.promoteMin}
            onCommit={(n) => patch({ promoteMin: Math.max(1, Math.round(n)) })} />
          <Num label="themes ≤" value={hyper?.promoteTop ?? DEFAULT_TAG_AIM.promoteTop}
            onCommit={(n) => patch({ promoteTop: Math.max(0, Math.round(n)) })} />
        </>
      )}
      {restDynCapable(profile) && (
        <Flag label="dyn" value={hyper?.dyn === true} onCommit={(v) => patch({ dyn: v })} />
      )}
      <Pick label="window" value={mode} options={REST_WINDOW_MODES}
        onCommit={(v) => patch({ mode: v })} />
      <Flag label="urls" value={hyper?.urls ?? profile.urls}
        onCommit={(v) => patch({ urls: v })} />
      {profile.knobs.map((knob) => (
        <Num
          key={knob}
          label={TAG_CHANNEL_LABEL[knob]}
          value={effective[knob] ?? 0}
          onCommit={(n) => patch({ weights: { ...hyper?.weights, [knob]: n } })}
        />
      ))}
      <Num label="topK" value={effective.topK ?? 0} onCommit={(n) => patch({ topK: n })} />
      <Num label="min" value={effective.minScore ?? 0} onCommit={(n) => patch({ minScore: n })} />
      <Num label="rows" value={hyper?.limit ?? profile.limit} onCommit={(n) => patch({ limit: n })} />
      {(profile.rank || hyper?.rank) && (
        <>
          <Num label="graph w" value={rank.window} onCommit={(n) => patch({ rank: { ...hyper?.rank, window: n } })} />
          <Num label="damp" value={rank.damping} onCommit={(n) => patch({ rank: { ...hyper?.rank, damping: n } })} />
          <Num label="iters" value={rank.iterations} onCommit={(n) => patch({ rank: { ...hyper?.rank, iterations: n } })} />
          <Num label="tol" value={rank.tol} onCommit={(n) => patch({ rank: { ...hyper?.rank, tol: n } })} />
          <Num label="minLen" value={rank.minLength} onCommit={(n) => patch({ rank: { ...hyper?.rank, minLength: n } })} />
        </>
      )}
      {(profile.trie || hyper?.trie) && (
        <>
          <Num label="fuzz" value={trie.distance}
            onCommit={(n) => patch({ trie: { ...hyper?.trie, distance: Math.max(0, Math.round(n)) } })} />
          <Pick label="overlap" value={trie.overlap}
            options={[
              { value: 'greedy', label: 'greedy' },
              { value: 'optimal', label: 'optimal (weighted)' },
            ]}
            onCommit={(v) => patch({ trie: { ...hyper?.trie, overlap: v } })} />
        </>
      )}
      <button style={BUTTON} onClick={() => onChange({})}>reset</button>
    </div>
  );
}
