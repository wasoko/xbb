// src/ui/restTuner.tsx
import React, { useState } from 'react';
import { DEFAULT_BM25, DEFAULT_BUCKETS, DEFAULT_GLOBAL, DEFAULT_RRF } from '../rstag';
import { DEFAULT_QARF } from '../qarf';
import { DEFAULT_TAG_AIM, DEFAULT_TEXTRANK, DEFAULT_TRIE, TAG_CHANNEL_LABEL } from '../srctag';
import {
  REST_PROFILES, REST_VIZ_MODES, REST_WINDOW_MODES, ROWS_ALL, restAim, restDynCapable, restHyperScore,
  restVizMode, type RestHyper, type RestTagProfile,
} from './restGrouper';
import { knobHelp, PROFILE_HELP, TUNER_HELP, VIZ_HELP, vizCaveat, WINDOW_HELP } from './restHelp';

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

/** The in-place note the strip adds when a reading does not fit the family on screen. */
const HINT: React.CSSProperties = { opacity: 0.45, fontStyle: 'italic', fontSize: '0.72em' };

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
 *
 * A knob that accepts "all" renders its sentinel as an empty box and commits
 * that value back when the box is cleared, so a cap is lifted by erasing it
 * rather than by typing a number large enough to cover the table.
 */
function Num({ label, value, onCommit, help, emptyValue }: {
  label: string; value: number; onCommit: (n: number) => void; help?: string;
  /** Value the box renders as empty, and commits again when it is cleared. */
  emptyValue?: number;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const blank = emptyValue !== undefined && value === emptyValue;
  return (
    <label style={ROW} title={help}>
      <span style={LABEL}>{label}</span>
      <input
        type="text" inputMode="decimal" value={draft ?? (blank ? '' : String(value))}
        placeholder={blank ? 'all' : undefined}
        onChange={(e) => {
          const text = e.target.value;
          setDraft(text);
          if (text.trim() === '') {
            if (emptyValue !== undefined) onCommit(emptyValue);
            return;
          }
          const n = Number(text);
          if (Number.isFinite(n)) onCommit(n);
        }}
        onBlur={() => setDraft(null)}
        style={FIELD}
      />
    </label>
  );
}

/** One checkbox bound to a boolean knob. */
function Flag({ label, value, onCommit, help }: {
  label: string; value: boolean; onCommit: (v: boolean) => void; help?: string;
}) {
  return (
    <label style={ROW} title={help}>
      <input type="checkbox" checked={value} onChange={(e) => onCommit(e.target.checked)} />
      <span style={LABEL}>{label}</span>
    </label>
  );
}

/** One free-text knob: a list of words, separated by any run of non-word characters. */
function Text({ label, value, onCommit, help }: {
  label: string; value: string[]; onCommit: (v: string[]) => void; help?: string;
}) {
  const joined = value.join(' ');
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <label style={ROW} title={help}>
      <span style={LABEL}>{label}</span>
      <input
        type="text" value={draft ?? joined} size={28}
        onChange={(e) => {
          setDraft(e.target.value);
          onCommit(e.target.value.split(/[\s,;]+/).filter(Boolean));
        }}
        onBlur={() => setDraft(null)}
        style={{ ...FIELD, width: 160 }}
      />
    </label>
  );
}

/** One select bound to a string knob. */
function Pick<T extends string>({ label, value, options, onCommit, help, helpFor }: {
  label: string; value: T; options: { value: T; label: string }[]; onCommit: (v: T) => void;
  help?: string;
  /** One line per option, so the open list explains what each choice reads. */
  helpFor?: (v: T) => string | undefined;
}) {
  return (
    <label style={ROW} title={help}>
      <span style={LABEL}>{label}</span>
      <select value={value} onChange={(e) => onCommit(e.target.value as T)}
        style={{ ...FIELD, width: 'auto' }}>
        {options.map((o) => (
          <option key={o.value} value={o.value} title={helpFor?.(o.value)}>{o.label}</option>
        ))}
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
 * Every control carries a native tooltip from `restHelp`, and the strip names in
 * place a reading the family on screen does not score, so the five readings are
 * not read as five equivalent views.
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
  const bm25 = {
    ...DEFAULT_BM25, ...profile.bm25, ...hyper?.bm25,
    fields: { ...DEFAULT_BM25.fields, ...profile.bm25?.fields, ...hyper?.bm25?.fields },
  };
  const rrf = { ...DEFAULT_RRF, ...profile.rrf, ...hyper?.rrf };
  const qarf = { ...DEFAULT_QARF, ...profile.qarf, ...hyper?.qarf };
  const buckets = { ...DEFAULT_BUCKETS, ...profile.buckets, ...hyper?.buckets };
  const global = { ...DEFAULT_GLOBAL, ...profile.global, ...hyper?.global };
  const mode = hyper?.mode ?? profile.mode;
  const viz = restVizMode(profile, hyper);
  const aim = restAim(profile, hyper) !== false;
  const patch = (p: RestHyper) => onChange({ ...hyper, ...p });
  /* A reading the family on screen does not score is still offered; saying so in
     place is what keeps the strip from reading as five equivalent views. */
  const caveat = vizCaveat(viz, effective);

  return (
    <div className="rest-hyper" style={BAR}>
      <span style={LABEL} title={PROFILE_HELP[grouper]}>{grouper}</span>
      <Pick label="viz" value={viz} options={REST_VIZ_MODES}
        help={`${TUNER_HELP.viz} — ${VIZ_HELP[viz]}`}
        helpFor={(v) => VIZ_HELP[v]}
        onCommit={(v) => patch({ viz: v })} />
      {caveat && <span style={HINT} title={caveat}>{caveat}</span>}
      <Flag label="aim" value={aim} help={TUNER_HELP.aim} onCommit={(v) => patch({ aim: v })} />
      {aim && (
        <>
          <Num label="aimMin" value={hyper?.aimMin ?? 0.4} help={TUNER_HELP.aimMin}
            onCommit={(n) => patch({ aimMin: n })} />
          <Num label="promote ≥" value={hyper?.promoteMin ?? DEFAULT_TAG_AIM.promoteMin}
            help={TUNER_HELP.promoteMin}
            onCommit={(n) => patch({ promoteMin: Math.max(1, Math.round(n)) })} />
          <Num label="themes ≤" value={hyper?.promoteTop ?? DEFAULT_TAG_AIM.promoteTop}
            help={TUNER_HELP.promoteTop}
            onCommit={(n) => patch({ promoteTop: Math.max(0, Math.round(n)) })} />
        </>
      )}
      {restDynCapable(profile) && (
        <Flag label="dyn" value={hyper?.dyn === true} help={TUNER_HELP.dyn}
          onCommit={(v) => patch({ dyn: v })} />
      )}
      <Pick label="window" value={mode} options={REST_WINDOW_MODES} help={TUNER_HELP.window}
        helpFor={(v) => WINDOW_HELP[v]}
        onCommit={(v) => patch({ mode: v })} />
      <Flag label="urls" value={hyper?.urls ?? profile.urls} help={TUNER_HELP.urls}
        onCommit={(v) => patch({ urls: v })} />
      {profile.knobs.map((knob) => (
        <Num
          key={knob}
          label={TAG_CHANNEL_LABEL[knob]}
          value={effective[knob] ?? 0}
          help={knobHelp(knob)}
          onCommit={(n) => patch({ weights: { ...hyper?.weights, [knob]: n } })}
        />
      ))}
      <Num label="topK" value={effective.topK ?? 0} help={TUNER_HELP.topK}
        onCommit={(n) => patch({ topK: n })} />
      <Num label="min" value={effective.minScore ?? 0} help={TUNER_HELP.minScore}
        onCommit={(n) => patch({ minScore: n })} />
      <Num label="rows" value={hyper?.limit ?? profile.limit} help={TUNER_HELP.rows}
        emptyValue={profile.limit === ROWS_ALL ? ROWS_ALL : undefined}
        onCommit={(n) => patch({ limit: n })} />
      {(profile.rank || hyper?.rank) && (
        <>
          <Num label="graph w" value={rank.window} help={TUNER_HELP.graphWindow}
            onCommit={(n) => patch({ rank: { ...hyper?.rank, window: n } })} />
          <Num label="damp" value={rank.damping} help={TUNER_HELP.damping}
            onCommit={(n) => patch({ rank: { ...hyper?.rank, damping: n } })} />
          <Num label="iters" value={rank.iterations} help={TUNER_HELP.iterations}
            onCommit={(n) => patch({ rank: { ...hyper?.rank, iterations: n } })} />
          <Num label="tol" value={rank.tol} help={TUNER_HELP.tol}
            onCommit={(n) => patch({ rank: { ...hyper?.rank, tol: n } })} />
          <Num label="minLen" value={rank.minLength} help={TUNER_HELP.minLength}
            onCommit={(n) => patch({ rank: { ...hyper?.rank, minLength: n } })} />
        </>
      )}
      {(profile.trie || hyper?.trie) && (
        <>
          <Num label="fuzz" value={trie.distance} help={TUNER_HELP.trieDistance}
            onCommit={(n) => patch({ trie: { ...hyper?.trie, distance: Math.max(0, Math.round(n)) } })} />
          <Pick label="overlap" value={trie.overlap} help={TUNER_HELP.trieOverlap}
            options={[
              { value: 'greedy', label: 'greedy' },
              { value: 'optimal', label: 'optimal (weighted)' },
            ]}
            onCommit={(v) => patch({ trie: { ...hyper?.trie, overlap: v } })} />
        </>
      )}
      {(profile.bm25 || hyper?.bm25) && (
        <>
          <Num label="k1" value={bm25.k1} help={TUNER_HELP.bm25K1}
            onCommit={(n) => patch({ bm25: { ...hyper?.bm25, k1: n } })} />
          <Num label="b" value={bm25.b} help={TUNER_HELP.bm25B}
            onCommit={(n) => patch({ bm25: { ...hyper?.bm25, b: n } })} />
          {(['title', 'url', 'tags'] as const).map((field) => (
            <Num key={field} label={`w ${field}`} value={bm25.fields[field] ?? 0}
              help={TUNER_HELP.bm25Field}
              onCommit={(n) => patch({ bm25: { ...hyper?.bm25, fields: { ...hyper?.bm25?.fields, [field]: n } } })} />
          ))}
        </>
      )}
      {(profile.global || hyper?.global) && (
        <>
          <Num label="max df" value={global.maxDf} help={TUNER_HELP.maxDf}
            onCommit={(n) => patch({ global: { ...hyper?.global, maxDf: Math.min(1, Math.max(0, n)) } })} />
          <Text label="stop" value={global.stop} help={TUNER_HELP.stop}
            onCommit={(v) => patch({ global: { ...hyper?.global, stop: v } })} />
        </>
      )}
      {(profile.rrf || hyper?.rrf) && (
        <Num label="rrf k" value={rrf.k} help={TUNER_HELP.rrfK}
          onCommit={(n) => patch({ rrf: { ...hyper?.rrf, k: Math.max(1, Math.round(n)) } })} />
      )}
      {(profile.qarf || hyper?.qarf) && (
        <Num label="qarf α" value={qarf.alpha} help={TUNER_HELP.qarfAlpha}
          onCommit={(n) => patch({ qarf: { ...hyper?.qarf, alpha: Math.max(0, n) } })} />
      )}
      {aim && (profile.buckets || hyper?.buckets) && (
        <>
          <Num label="mmr λ" value={buckets.lambda} help={TUNER_HELP.bucketLambda}
            onCommit={(n) => patch({ buckets: { ...hyper?.buckets, lambda: Math.min(1, Math.max(0, n)) } })} />
          <Num label="graph λ" value={buckets.graph} help={TUNER_HELP.bucketGraph}
            onCommit={(n) => patch({ buckets: { ...hyper?.buckets, graph: Math.max(0, n) } })} />
        </>
      )}
      <button style={BUTTON} title={TUNER_HELP.reset} onClick={() => onChange({})}>reset</button>
    </div>
  );
}
