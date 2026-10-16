/**
 * RestGraph.tsx — the tag graph as inline SVG.
 *
 * Pinned tags sit at the centre, the tags rows are filed under ring them, promoted
 * themes sit between a head and the outer ring, and a chip no head claims takes the
 * outer ring itself. Node radius is how many scored rows kept the tag, and — the
 * part that is `qarf`'s rather than any pass's — a node's outline is the mean lexical
 * share of those rows: warm where the exact lexical lists carried them, cool where
 * the neighbour walks did.
 *
 * A node's hover text names what it is and how far the pass read it; a click hands
 * the tag back to the caller, which is what lets the wide view scroll the list to
 * that tag's block.
 */

import React from 'react';
import { shareCue, tagCue } from './restCue';
import { GRAPH_NODE_KIND, tagGraphLayout, type GraphLayoutOptions, type TagGraph } from './restGraph';

/** The drawing box, square so the rings stay circular. */
const SIZE = 640;
/** Centre of that box. */
const CX = SIZE / 2;
/** Distance the outermost ring sits at, leaving room for a label above a node. */
const SPAN = SIZE / 2 - 64;

/** The marker, name and help of one kind, as a legend or a hover renders it. */
export interface KindLabel {
  mark: string;
  label: string;
  help: string;
}

/** Props of {@link RestGraph}. */
export interface RestGraphProps {
  graph: TagGraph;
  /** Tag to outline, so the block the reader is on reads at a glance. */
  active?: string;
  /** Called with a node's tag when it is clicked. */
  onFocus?: (tag: string) => void;
  /** How to name each kind; defaults to the pass's own kinds. */
  kinds?: Record<string, KindLabel>;
  /** Which taxonomy to read the graph in, and the ring each kind sits on. */
  layout?: GraphLayoutOptions;
}

const PANE: React.CSSProperties = {
  display: 'block', width: '100%', height: '100%', overflow: 'hidden',
};

const EMPTY: React.CSSProperties = { padding: 8, opacity: 0.6 };

/**
 * Draw a tag graph.
 *
 * @param props.graph - the graph, as `restGraph.buildTagGraph` returns it.
 * @param props.active - tag to outline.
 * @param props.onFocus - click handler, given the tag.
 * @param props.kinds - how to name each kind.
 * @param props.layout - which taxonomy to read it in.
 * @returns The SVG element, or a placeholder when the graph holds nothing.
 */
export function RestGraph({ graph, active, onFocus, kinds = GRAPH_NODE_KIND, layout: read }: RestGraphProps) {
  const layout = tagGraphLayout(graph, read);
  if (layout.nodes.length === 0) return <div style={EMPTY}>no graph nodes</div>;

  const at = (n: { x: number; y: number }) => ({ x: CX + n.x * SPAN, y: CX + n.y * SPAN });
  const placed = layout.nodes.map((n) => ({ n, p: at(n) }));
  const pos = new Map(placed.map(({ n, p }) => [n.tag, p]));

  return (
    <svg viewBox={`0 0 ${SIZE} ${SIZE}`} width="100%" height="100%" role="img"
      aria-label={`tag graph over ${layout.nodes.length} tags`} style={PANE}>
      {layout.edges.map((e) => {
        const pa = pos.get(e.a);
        const pb = pos.get(e.b);
        if (!pa || !pb) return null;
        return (
          <line key={`${e.a}\u0000${e.b}`} x1={pa.x} y1={pa.y} x2={pb.x} y2={pb.y}
            stroke="rgba(150,170,200,0.28)" strokeWidth={0.4 + 2.2 * (e.w / layout.maxEdge)} />
        );
      })}
      {placed.map(({ n, p }) => {
        const kind = kinds[n.kind] ?? { mark: '·', label: String(n.kind), help: '' };
        return (
          <g key={n.tag} onClick={() => onFocus?.(n.tag)}
            style={onFocus ? { cursor: 'pointer' } : undefined}>
            <title>{[
              `${kind.mark} #${n.tag} — ${kind.label}`,
              kind.help,
              `${n.rows} scored row(s) kept it`,
              ...(n.lambda === undefined
                ? []
                : [`mean lexical share ${n.lambda.toFixed(2)} — warm is the exact lists, cool the walks`]),
            ].join('\n')}</title>
            <circle cx={p.x} cy={p.y} r={4 + n.r * SPAN}
              fill={n.kind === 'pinned' ? tagCue(n.tag) : 'rgba(20,26,36,0.9)'}
              stroke={n.lambda === undefined ? tagCue(n.tag) : shareCue(n.lambda)}
              strokeWidth={active === n.tag ? 3 : n.rows > 1 ? 2.5 : 1}
              strokeDasharray={n.kind === 'theme' ? '3 2' : undefined} />
          </g>
        );
      })}
      {/* Labels only for what a reader needs to find: the pins, the heads, and any
          tag more than one row kept. */}
      {placed.filter(({ n }) => n.kind === 'pinned' || n.kind === 'head' || n.rows > 1).map(({ n, p }) => (
        <text key={n.tag} x={p.x} y={p.y - 8 - n.r * SPAN} fill={tagCue(n.tag)}
          fontSize={11} textAnchor="middle">
          {`#${n.tag}${n.rows > 1 ? ` (${n.rows})` : ''}`}
        </text>
      ))}
    </svg>
  );
}
