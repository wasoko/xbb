/**
 * SeaView.tsx — the sea as a wall: a tag canvas on a cylinder, the star at sea level, and the
 * camera body that is dragged through it.
 *
 * The taxonomy the star's seed produces is packed once by `seaWall.buildWall` into rectangles
 * on the cylinder. The star is the split meridian: emerging recent tags keep the left band,
 * pin-card top headings keep the right band, and each top-level heading owns the next heading
 * level (or the tag's one-hop neighbours) as a treemap below it. The rest of the tags stay on
 * the rear half, where a horizontal spacing change can bring them round. Every row a tag was
 * kept by is a point inside its region. Nothing is sampled or invented.
 *
 * The camera is the one the feel module describes: a spring-damped body, scroll and yaw that
 * coast, five pitch detents, and a field of view the feel eases. Sea level is rise 0; the
 * star marks the split meridian, with the newest recent tag to its left and the newest pinned
 * heading to its right. Above the horizon the canvas is almost black and catches the star's
 * light; below it is tinted and readable.
 *
 * The only DOM is the card. It names the tag, says what the taxonomy calls it, lists the
 * relations the table itself records, and offers the rows that can be opened. A tap or click
 * on a row star pins the card where it landed; the card can be dragged by its header and
 * resized from its corner. A click on a region still locks the camera. A pinch splits into
 * its horizontal and vertical parts and moves the wall's spacing apart; Ctrl/⌘ + wheel moves
 * the vertical spacing and Shift + wheel moves the horizontal one. Labels fit the
 * region at the spacing it is drawn at, so a compressed wall also compresses its names.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { daRead, treeCac } from '../sdb';
import {
  STAR_TAGGER_REF, parseStarTaggerDoc, starSetupFingerprint,
} from '../starTagger';
import { dasStamp, ensureStarTaggerRow, readStarCache, sameStamp, saveStarSeed } from './starTaggerRun';
import { loadPinGraph, type PinGraphSeed } from './seaPinGraph';
import { restTagStore } from './restGrouper';
import {
  kindLabel, parseRelations, parseTaxonomy, parseTaxonomyDoc, relationsOf, seaPinsOf,
  seaRowsByTag, seaTagPool, graphFromTags,
  NO_RELATIONS, type SeaAction, type SeaRelations, type SeaRow, type TagRelation,
} from './seaTags';
import {
  SEA_FEEL, createRig, leanedPitch, levelPitch, notch, poseSettled, stepRig, wheelScroll,
  type SeaPose, type SeaRig,
} from './seaFeel';
import { SEA_MOMENTUM_KEY } from './seaMotion';
import { SeaRenderer, type SeaHover, type SeaWallPick } from './seaRender';
import { noteSeaFrame } from '../perfWatch';
import { buildWall, type WallRegion } from './seaWall';
import { EMERGING_CHILDREN, EMERGING_COLUMNS, emergingTags } from './seaTrend';
import type { TagGraph } from './restGraph';

/** Pointer travel under this, in pixels, is a click rather than a drag. */
const CLICK_SLOP = 5;

/** Milliseconds between two hover readings, so a move does not pick per event. */
const HOVER_MS = 60;

/** Rig units one degree of rise is worth: the wall's own scale, in the approved feel's units. */
const DEG_PER_UNIT = 2;

/** Smallest and largest wall spacing a pinch may ask for. */
const SPACING_MIN = 0.35;
const SPACING_MAX = 3;

/** Degrees per radian, for the compass bearing. */
const DEG = 180 / Math.PI;

/** The compass's own size, in CSS pixels: a round map-style control. */
const COMPASS_SIZE = 76;

/** Where the compass hangs: the map-control corner, above the app's dock. */
const COMPASS: React.CSSProperties = {
  position: 'fixed', right: 16, bottom: 158, zIndex: 2, width: COMPASS_SIZE,
  height: COMPASS_SIZE, cursor: 'pointer', pointerEvents: 'auto',
  filter: 'drop-shadow(0 4px 14px rgba(0,0,0,0.6))',
};

/** The pointer's last position, for the card the lock keeps open. */
const NO_POINTER = { x: 24, y: 24 };

/** What the pointer is over, plus where to hang its card. */
interface HoverState {
  target: SeaHover;
  x: number;
  y: number;
}

/** A locked region, in rig units and radians. */
interface LockState {
  tag: string;
  rise: number;
  yaw: number;
  target: SeaHover;
}

/** A card's position and size, in CSS pixels. */
interface CardBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One card drag or resize in progress. */
interface CardDrag {
  id: number;
  mode: 'move' | 'resize';
  x: number;
  y: number;
  box: CardBox;
}

/** Where the sea is put: full screen, behind the app's own chrome. */
const MOUNT: React.CSSProperties = {
  position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', zIndex: 0,
  userSelect: 'none',
};

/** The canvas host inside that element. */
const CANVAS_HOST: React.CSSProperties = { position: 'absolute', inset: 0 };

/** The card's default and minimum size, in CSS pixels. */
const CARD_W = 340;
const CARD_H = 320;
const CARD_MIN_W = 220;
const CARD_MIN_H = 120;

/** The card: moved and resized by its header and corner. */
const CARD: React.CSSProperties = {
  position: 'fixed', zIndex: 3, display: 'flex', flexDirection: 'column',
  overflow: 'hidden', borderRadius: 10, color: 'rgba(232,240,248,0.94)',
  background: 'rgba(5,8,13,0.9)', border: '1px solid rgba(255,255,255,0.14)',
  backdropFilter: 'blur(10px)', fontSize: 12, lineHeight: '16px',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  boxShadow: '0 12px 40px rgba(0,0,0,0.55)', boxSizing: 'border-box',
};

const CARD_HEAD: React.CSSProperties = {
  cursor: 'move', touchAction: 'none', userSelect: 'none', flex: '0 0 auto',
  padding: '9px 11px 4px', background: 'rgba(5,8,13,0.96)',
};

const CARD_BODY: React.CSSProperties = {
  flex: '1 1 auto', overflow: 'auto', touchAction: 'pan-y', padding: '0 11px 9px',
};

const CARD_GRIP: React.CSSProperties = {
  position: 'absolute', right: 2, bottom: 2, width: 14, height: 14,
  cursor: 'nwse-resize', touchAction: 'none', borderRadius: 2,
  background: 'linear-gradient(135deg, transparent 48%, rgba(255,255,255,0.28) 50%)',
};

const CARD_TAG: React.CSSProperties = {
  fontWeight: 700, fontSize: 14, color: '#ffe6b8', whiteSpace: 'nowrap',
  overflow: 'hidden', textOverflow: 'ellipsis', marginBottom: 2,
};

const CARD_META: React.CSSProperties = {
  color: 'rgba(232,240,248,0.55)', fontSize: 11, marginBottom: 6, whiteSpace: 'nowrap',
  overflow: 'hidden', textOverflow: 'ellipsis',
};

const CARD_SECTION: React.CSSProperties = {
  color: 'rgba(232,240,248,0.4)', fontSize: 10, letterSpacing: '0.08em',
  textTransform: 'uppercase', margin: '6px 0 2px',
};

const CARD_REL: React.CSSProperties = {
  display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 2,
};

/** One relation chip. The kind is carried by the chip's colour, so the list keeps a single
 *  dot before each tag instead of repeating `burst ·` or `web ·` on every chip. */
const relationStyle = (kind: TagRelation['kind'], jumpable: boolean): React.CSSProperties => ({
  padding: '1px 5px', borderRadius: 4, fontSize: 10, border: 'none', fontFamily: 'inherit',
  background: 'rgba(255,255,255,0.06)', cursor: jumpable ? 'pointer' : 'default',
  opacity: jumpable ? 1 : 0.55,
  color: kind === 'pin' ? '#ffe6b8'
    : kind === 'theme' ? '#c7a6ff'
      : kind === 'burst' ? '#ffb27a'
        : kind === 'alias' ? '#d6d9ff' : '#8fe3ff',
});

const CARD_ROW: React.CSSProperties = {
  display: 'block', width: '100%', textAlign: 'left', padding: '2px 4px', margin: '1px 0',
  border: 'none', borderRadius: 5, background: 'transparent', cursor: 'pointer',
  color: 'rgba(255,196,120,0.92)', font: 'inherit', whiteSpace: 'nowrap',
  overflow: 'hidden', textOverflow: 'ellipsis',
};

const CARD_ROW_EDITOR: React.CSSProperties = { ...CARD_ROW, color: 'rgba(150,226,255,0.92)' };

/** A notice shown where the world cannot be drawn. */
const NOTICE: React.CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 0, display: 'flex', alignItems: 'center',
  justifyContent: 'center', color: 'rgba(230,236,244,0.55)', fontSize: 13,
  background: 'rgba(3,6,10,1)', textAlign: 'center', padding: 24,
};

/** A quiet line while the taxonomy is still being read. */
const WAITING: React.CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 1, display: 'flex', alignItems: 'center',
  justifyContent: 'center', color: 'rgba(230,236,244,0.45)', fontSize: 12,
  pointerEvents: 'none', fontFamily: 'ui-monospace, monospace',
};

/** Keep a card inside the viewport and above its minimum size. */
function clampCard(box: CardBox): CardBox {
  const w = Math.min(Math.max(CARD_MIN_W, box.w), Math.max(CARD_MIN_W, window.innerWidth - 16));
  const h = Math.min(Math.max(CARD_MIN_H, box.h), Math.max(CARD_MIN_H, window.innerHeight - 16));
  return {
    w,
    h,
    x: Math.min(Math.max(8, box.x), Math.max(8, window.innerWidth - w - 8)),
    y: Math.min(Math.max(8, box.y), Math.max(8, window.innerHeight - h - 8)),
  };
}

/** Where a card opens for a pointer or a lock. */
function defaultCardBox(active: HoverState): CardBox {
  return clampCard({
    x: active.x + 18, y: active.y + 18,
    w: CARD_W, h: Math.min(CARD_H, Math.max(CARD_MIN_H, window.innerHeight - 16)),
  });
}

/** The stored momentum setting as `[0, 1]`, with an unset value at the shipped middle. */
function momentumOf(stored: unknown): number {
  const n = Number(stored);
  if (stored === undefined || stored === null || stored === '' || !Number.isFinite(n)) return 0.5;
  return Math.min(1, Math.max(0, n / 100));
}

/** A row's opening, for both atlas rows and wall points. */
function openRowOf(navigate: (to: string) => void, ref: string, action: SeaAction): void {
  if (action === 'link') {
    window.open(ref, '_blank', 'noopener,noreferrer');
    return;
  }
  navigate(`/tabs?e=${encodeURIComponent(ref)}&tabs=${encodeURIComponent(ref)}`);
}

/**
 * The sea: the tag wall, the camera body, the star, and its card.
 *
 * @param props.foreground whether the sea is the route in front; a route that draws its own
 *        panes keeps its own pointer, so the sea only takes it here
 * @returns the canvas host and the card
 */
export function SeaView({ foreground }: { foreground: boolean }) {
  const navigate = useNavigate();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const mountRef = useRef<HTMLDivElement | null>(null);
  const compassRef = useRef<HTMLCanvasElement | null>(null);
  const resetRef = useRef<() => void>(() => {});
  const rendererRef = useRef<SeaRenderer | null>(null);
  const rigRef = useRef<SeaRig>(createRig());
  const rowsRef = useRef<Map<string, SeaRow[]>>(new Map());
  const graphRef = useRef<TagGraph | null>(null);
  const relationsRef = useRef<SeaRelations>(NO_RELATIONS);
  const lockedRef = useRef<LockState | null>(null);
  const lockRef = useRef<(hit: SeaWallPick) => void>(() => {});
  const applyRef = useRef<() => void>(() => {});
  const spacingRef = useRef({ x: 1, y: 1 });

  const [failure, setFailure] = useState<string | null>(null);
  const [seedError, setSeedError] = useState<string | null>(null);
  const [seed, setSeed] = useState<PinGraphSeed | null>(null);
  const [hover, setHover] = useState<HoverState | null>(null);
  const [sticky, setSticky] = useState<HoverState | null>(null);
  const [locked, setLocked] = useState<LockState | null>(null);
  const [lastPointer, setLastPointer] = useState(NO_POINTER);
  const [cardBox, setCardBox] = useState<CardBox | null>(null);
  const stickyRef = useRef<HoverState | null>(null);
  const cardDragRef = useRef<CardDrag | null>(null);

  /* The row decides the seed and holds the overridable relation mapping; the generated
     table and the seed it was read from are one `db.bins` record. */
  const taggerRow = useLiveQuery(async () => (await daRead(STAR_TAGGER_REF, 'md')) ?? null, [], null);
  const tagger = useMemo(
    () => (taggerRow === null ? null : parseStarTaggerDoc(taggerRow.txt)),
    [taggerRow?.txt],
  );
  const cache = useLiveQuery(async () => (await readStarCache()) ?? null, [], null);
  /* A row written by an older build still carries its `## Taxonomy`; that is what a first
     mount opens on until the first seed writes the cache. */
  const legacy = useMemo(
    () => (tagger === null ? { tags: [], relations: NO_RELATIONS } : parseTaxonomyDoc(tagger.taxonomy)),
    [tagger?.taxonomy],
  );
  const relations = useMemo<SeaRelations>(() => {
    const mapping = tagger === null ? NO_RELATIONS : parseRelations(tagger.mapping);
    const bursts = cache === null ? legacy.relations.bursts : parseRelations(cache.taxonomy).bursts;
    const setup = tagger?.setup;
    return {
      web: setup?.noWeb === true ? [] : mapping.web,
      themes: setup?.noTheme === true ? [] : mapping.themes,
      bursts,
      aliases: mapping.aliases,
      synonyms: setup?.noSyn === true ? [] : mapping.synonyms,
    };
  }, [tagger?.mapping, tagger?.setup, cache, legacy]);
  const tags = useMemo(
    () => seaTagPool(cache === null ? legacy.tags : parseTaxonomy(cache.taxonomy), seed),
    [cache, legacy.tags, seed],
  );
  const rowsByTag = useMemo(
    () => (seed === null ? new Map<string, SeaRow[]>() : seaRowsByTag(seed)),
    [seed],
  );
  const graph = useMemo(
    () => {
      const base = seed?.graph ?? graphFromTags(tags, relations);
      /* The generated table is the durable reading, so a pinned reach there roots the wall
         even when the pin cards themselves are not readable in this profile. */
      const pinned = tags.filter((tag) => tag.reach === 'pinned').map((tag) => tag.tag);
      if (pinned.every((tag) => base.roots.has(tag))) return base;
      const roots = new Set(base.roots);
      for (const tag of pinned) roots.add(tag);
      return { ...base, roots };
    },
    [seed, tags, relations],
  );
  const wall = useMemo(
    () => (tags.length === 0
      ? null
      : buildWall(graph, tags, (tag) => rowsByTag.get(tag) ?? [], {
        /* The wall opens at the feel's narrow field of view, so the column is narrower than
           the old wide-wall packing and the strips come into view beside it. */
        pinCol: 32,
        shelfGap: 5,
        areaPerRow: 4,
        minW: 12,
        minH: 12,
        maxH: 36,
        maxRegions: 260,
        ...(seed === null ? {} : {
          recency: (tag: string) => seed.recency.get(tag),
          pins: seaPinsOf(seed.pins, graph),
        }),
        emerging: seed === null
          ? tags
            .filter((tag) => tag.trend !== undefined && tag.trend > 0
              && !graph.roots.has(tag.tag) && graph.alias.get(tag.tag) === undefined)
            .sort((a, b) => (b.trend ?? 0) - (a.trend ?? 0) || b.weight - a.weight)
            .slice(0, EMERGING_COLUMNS)
            .map((tag) => ({
              tag: tag.tag, score: tag.trend ?? 0,
              children: [...(graph.edges.get(tag.tag) ?? [])]
                .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
                .slice(0, EMERGING_CHILDREN)
                .map(([child]) => child),
            }))
          : emergingTags(graph, seed.trend, {
            maxEmerging: EMERGING_COLUMNS, maxChildren: EMERGING_CHILDREN,
          }),
      })),
    [graph, tags, rowsByTag, seed],
  );
  /** The tags the wall carries, so a relation chip can say whether its tag has a region. */
  const regionTags = useMemo(
    () => new Set((wall?.regions ?? []).map((region) => region.tag)),
    [wall],
  );

  useEffect(() => { rowsRef.current = rowsByTag; }, [rowsByTag]);
  useEffect(() => { graphRef.current = graph; }, [graph]);
  useEffect(() => { relationsRef.current = relations; }, [relations]);
  useEffect(() => { lockedRef.current = locked; }, [locked]);
  useEffect(() => {
    if (!foreground) {
      setHover(null);
      setSticky(null);
      stickyRef.current = null;
    }
  }, [foreground]);
  useEffect(() => { stickyRef.current = sticky; }, [sticky]);

  const openRow = useCallback((ref: string, action: SeaAction) => {
    openRowOf(navigate, ref, action);
  }, [navigate]);
  /* The relations a region's hover shows, from the table's own relation lists. */
  const relationsFor = useCallback((region: WallRegion | undefined): TagRelation[] => {
    if (region === undefined) return [];
    const held = graphRef.current;
    if (held === null) return [];
    return relationsOf(region.tag, {
      relations: relationsRef.current,
      graph: held,
      ...(region.pin === undefined ? {} : { pin: region.pin }),
      ...(region.burst === undefined ? {} : { burst: region.burst }),
    });
  }, []);

  /* Point the camera at one region and keep its relations lit: the lock a click on the wall
     makes, shared with the hover card's relation chips. */
  const lockRegion = useCallback((region: WallRegion): void => {
    const next: LockState = {
      tag: region.tag,
      rise: ((region.rise0 + region.rise1) / 2) / DEG_PER_UNIT,
      yaw: (-((region.lon0 + region.lon1) / 2) * Math.PI) / 180,
      target: { region },
    };
    lockedRef.current = next;
    setLocked(next);
    rendererRef.current?.setHover(next.target, relationsFor(region));
  }, [relationsFor]);

  const toggleLock = useCallback((hit: SeaWallPick) => {
    setHover(null);
    setSticky(null);
    stickyRef.current = null;
    const region = hit.region;
    if (region === undefined) {
      lockedRef.current = null;
      setLocked(null);
      rendererRef.current?.setHover(null, []);
      return;
    }
    const current = lockedRef.current;
    if (current !== null && current.tag === region.tag) {
      lockedRef.current = null;
      setLocked(null);
      rendererRef.current?.setHover(null, []);
      return;
    }
    lockRegion(region);
  }, [lockRegion]);
  useEffect(() => { lockRef.current = toggleLock; }, [toggleLock]);

  /* A relation chip walks the table: the camera locks the tag the chip names, exactly as a
     click on its region does, so a hover card answers `where is that?` in place. */
  const jumpToRegion = useCallback((tag: string): void => {
    const region = wall?.regions.find((entry) => entry.tag === tag);
    if (region === undefined) return;
    setHover(null);
    setSticky(null);
    stickyRef.current = null;
    lockRegion(region);
  }, [wall, lockRegion]);

  /* Seed the row once so a fresh table has a place to write the mapping. */
  useEffect(() => {
    void ensureStarTaggerRow().catch((error: unknown) => {
      console.debug('[star.tagger] seed skipped', error);
    });
  }, []);

  /* Open on the cached seed while the table and Setup stand; re-seed when either changes,
     or once for a `reset: yes`. */
  const lastSeed = useRef<string | null>(null);
  const resetSeen = useRef(false);
  useEffect(() => {
    if (tagger === null) return;
    const key = starSetupFingerprint(tagger.setup);
    if (lastSeed.current !== key) resetSeen.current = false;
    if (tagger.setup.reset) {
      if (resetSeen.current) return;
      resetSeen.current = true;
    } else {
      resetSeen.current = false;
      if (lastSeed.current === key) return;
    }
    lastSeed.current = key;
    const setup = tagger.setup;
    setSeedError(null);
    let live = true;
    const publish = (loaded: PinGraphSeed) => {
      if (!live) return;
      setSeed(loaded);
      /* The omnibox's suggestion zone reads the seed's own pass until the rest list runs. */
      if (restTagStore.version === 0) {
        restTagStore.set(loaded.reports, loaded.rows, loaded.pins);
      }
    };
    void (async () => {
      const stamp = await dasStamp();
      const held = await readStarCache();
      if (!setup.reset && held !== undefined
        && held.fingerprint === key && sameStamp(held.stamp, stamp)) {
        publish(held.seed);
        return;
      }
      const loaded = await loadPinGraph(setup);
      if (!live) return;
      publish(loaded);
      await saveStarSeed(loaded, loaded.setup, loaded.timings);
    })().catch((error: unknown) => {
      console.debug('[sea] seed skipped', error);
      if (live) setSeedError(error instanceof Error ? error.message : String(error));
    });
    return () => { live = false; };
  }, [taggerRow?.txt]);

  /* Hand the wall to the renderer whenever the table or the seed changes. */
  const applyContent = useCallback(() => {
    const renderer = rendererRef.current;
    const next = wall;
    if (renderer === null || next === null) return;
    renderer.setContent(next);
    renderer.setSpacing(spacingRef.current.x, spacingRef.current.y);
    setHover(null);
    setSticky(null);
    stickyRef.current = null;
    setCardBox(null);
    lockedRef.current = null;
    setLocked(null);
  }, [wall]);
  useEffect(() => { applyRef.current = applyContent; }, [applyContent]);
  useEffect(() => { applyContent(); }, [applyContent]);

  /* The renderer, its input and its frame clock. */
  useEffect(() => {
    const mount = mountRef.current;
    const host = hostRef.current;
    if (!mount || !host) return;
    const canvas = document.createElement('canvas');
    canvas.className = 'sea-canvas';
    canvas.style.touchAction = 'none';
    canvas.style.display = 'block';
    canvas.setAttribute('aria-hidden', 'true');
    mount.appendChild(canvas);

    if (typeof WebGL2RenderingContext === 'undefined') {
      mount.removeChild(canvas);
      setFailure('This browser has no WebGL 2, so the sea cannot be drawn.');
      return;
    }

    let renderer: SeaRenderer;
    try {
      renderer = new SeaRenderer(canvas);
    } catch (error) {
      console.warn('[sea] renderer refused', error);
      mount.removeChild(canvas);
      setFailure('The graphics context could not be created, so the sea cannot be drawn.');
      return;
    }
    rendererRef.current = renderer;
    applyRef.current();

    const rig = rigRef.current;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    let still = reduced.matches;
    renderer.setReduced(still);
    const onReduced = (event: MediaQueryListEvent) => {
      still = event.matches;
      renderer.setReduced(still);
    };
    reduced.addEventListener('change', onReduced);

    const size = () => {
      const rect = mount.getBoundingClientRect();
      renderer.resize(rect.width, rect.height);
    };
    size();
    window.addEventListener('resize', size);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(size);
    observer?.observe(mount);

    /* ── input ─────────────────────────────────────────────────────────────── */

    const keys = new Set<string>();
    let shift = false;
    let dragging = false;
    let moved = 0;
    let lastX = 0;
    let lastY = 0;
    let lastAt = 0;
    let yawSpeed = 0;
    let scrollSpeed = 0;
    let hoverAt = 0;
    let lastClickAt = 0;
    let lastClickX = 0;
    let lastClickY = 0;
    const pointers = new Map<number, { x: number; y: number }>();
    let pinch: { dx: number; dy: number } | null = null;

    /** Degrees of rise one vertical drag pixel is worth. */
    const risePerPixel = (): number =>
      (2 * Math.tan((rig.fov * Math.PI) / 360) * (180 / Math.PI))
      / Math.max(1, mount.clientHeight) / DEG_PER_UNIT;

    /** Radians of turn one horizontal drag pixel is worth. */
    const yawPerPixel = (): number => {
      const aspect = mount.clientWidth / Math.max(1, mount.clientHeight);
      const hfov = 2 * Math.atan(Math.tan((rig.fov * Math.PI) / 360) * aspect);
      return hfov / Math.max(1, mount.clientWidth);
    };

    const setCursor = (pointer: boolean): void => {
      host.style.cursor = pointer ? 'pointer' : dragging ? 'grabbing' : 'grab';
    };

    const applyHover = (target: SeaHover | null, x: number, y: number): void => {
      setHover(target === null ? null : { target, x, y });
      renderer.setHover(target, relationsFor(target?.region));
    };

    /** Put the spotlight back on the lock after the pointer leaves a tag. */
    const applyLock = (target: SeaHover | null): void => {
      renderer.setHover(target, relationsFor(target?.region));
    };

    const showHover = (clientX: number, clientY: number): void => {
      setLastPointer({ x: clientX, y: clientY });
      const rect = canvas.getBoundingClientRect();
      const hit = renderer.pick(clientX - rect.left, clientY - rect.top);
      renderer.setPointer(clientX - rect.left, clientY - rect.top);
      if (hit === null) {
        applyHover(null, clientX, clientY);
        const stay = stickyRef.current;
        const held = lockedRef.current;
        if (stay !== null) applyLock(stay.target);
        else if (held !== null) applyLock(held.target);
        setCursor(false);
        return;
      }
      applyHover({ region: hit.region, point: hit.point }, clientX, clientY);
      setCursor(true);
    };

    /** Return to the origin meridian and sea level, with the star ahead. */
    const resetPose = (): void => {
      rig.scrollTarget = 0;
      rig.vScroll = 0;
      rig.yawTarget = 0;
      rig.vYaw = 0;
      if (rig.pitchIndex !== 2) {
        rig.pitchIndex = 2;
        rig.pitchFrom = rig.pitch;
        rig.pitchTo = 0;
        rig.pitchT = 0;
      }
      lockedRef.current = null;
      setLocked(null);
      setHover(null);
      setSticky(null);
      stickyRef.current = null;
      renderer.setHover(null, []);
    };

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const horizontalGesture = event.deltaX !== 0
        && Math.abs(event.deltaX) > Math.abs(event.deltaY);
      if (event.ctrlKey || event.metaKey || event.shiftKey || horizontalGesture) {
        /* Ctrl or ⌘ with the wheel changes the vertical spacing; Shift with the wheel
           changes the horizontal one, which is what pulls the rear tail into the front
           half. A horizontal wheel or pinch is the same horizontal gesture. Labels are
           fitted to the region at that spacing, so the text shrinks with its cell. */
        const spacing = spacingRef.current;
        const horizontal = event.shiftKey || horizontalGesture;
        const delta = horizontal ? (event.deltaX || event.deltaY) : event.deltaY;
        const factor = Math.exp(-delta * 0.0015);
        if (horizontal) {
          spacing.x = Math.min(SPACING_MAX, Math.max(SPACING_MIN, spacing.x * factor));
        } else {
          spacing.y = Math.min(SPACING_MAX, Math.max(SPACING_MIN, spacing.y * factor));
        }
        renderer.setSpacing(spacing.x, spacing.y);
        return;
      }
      wheelScroll(rig, event.deltaY * 2);
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const rect = canvas.getBoundingClientRect();
      renderer.setPointer(event.clientX - rect.left, event.clientY - rect.top);
      try {
        host.setPointerCapture(event.pointerId);
      } catch {
        /* A pointer can be gone before this handler runs, and capturing it then throws. */
      }
      if (pointers.size >= 2) {
        const [a, b] = [...pointers.values()];
        pinch = { dx: Math.abs(a.x - b.x), dy: Math.abs(a.y - b.y) };
        dragging = false;
        return;
      }
      dragging = true;
      moved = 0;
      lastX = event.clientX;
      lastY = event.clientY;
      lastAt = performance.now();
      yawSpeed = 0;
      scrollSpeed = 0;
      rig.vScroll = 0;
      rig.vYaw = 0;
      setCursor(false);
    };

    const onPointerMove = (event: PointerEvent) => {
      if (pointers.has(event.pointerId)) {
        pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      }
      if (pointers.size >= 2) {
        const [a, b] = [...pointers.values()];
        const dx = Math.abs(a.x - b.x);
        const dy = Math.abs(a.y - b.y);
        if (pinch !== null) {
          const spacing = spacingRef.current;
          /* A pinch changes spacing only; a component too small to measure is left alone,
             because a pair of fingers nearly vertical says nothing about the horizontal
             spacing. */
          if (pinch.dx > 24 && dx > 24) {
            spacing.x = Math.min(SPACING_MAX, Math.max(SPACING_MIN, spacing.x * (dx / pinch.dx)));
          }
          if (pinch.dy > 24 && dy > 24) {
            spacing.y = Math.min(SPACING_MAX, Math.max(SPACING_MIN, spacing.y * (dy / pinch.dy)));
          }
          renderer.setSpacing(spacing.x, spacing.y);
        }
        pinch = { dx, dy };
        return;
      }
      if (!dragging) {
        const at = performance.now();
        if (at - hoverAt >= HOVER_MS) {
          hoverAt = at;
          showHover(event.clientX, event.clientY);
        }
        return;
      }

      const dx = event.clientX - lastX;
      const dy = event.clientY - lastY;
      lastX = event.clientX;
      lastY = event.clientY;
      moved += Math.abs(dx) + Math.abs(dy);
      const at = performance.now();
      const ms = Math.max(1, at - lastAt);
      lastAt = at;

      /* Dragging right brings what was left into view; dragging down brings what was above.
         The body springs after the target, which is where the weight comes from. */
      rig.yawTarget -= dx * yawPerPixel();
      rig.scrollTarget += dy * risePerPixel();
      yawSpeed = -(dx * yawPerPixel()) / (ms / 1000);
      scrollSpeed = (dy * risePerPixel()) / (ms / 1000);
      if (moved > CLICK_SLOP) {
        setHover(null);
        if (stickyRef.current === null) renderer.setPointer(-1, -1);
      }
    };

    const onPointerUp = (event: PointerEvent) => {
      pointers.delete(event.pointerId);
      if (pointers.size < 2) pinch = null;
      if (host.hasPointerCapture(event.pointerId)) host.releasePointerCapture(event.pointerId);
      if (!dragging) return;
      dragging = false;
      if (moved <= CLICK_SLOP) {
        const now = performance.now();
        const isDouble = now - lastClickAt < 300
          && Math.hypot(event.clientX - lastClickX, event.clientY - lastClickY) < 30;
        lastClickAt = now;
        lastClickX = event.clientX;
        lastClickY = event.clientY;
        if (isDouble) {
          resetPose();
          return;
        }
        const rect = canvas.getBoundingClientRect();
        const px = event.clientX - rect.left;
        const py = event.clientY - rect.top;
        const hit = renderer.pick(px, py);
        renderer.setPointer(px, py);
        if (hit === null) {
          lockedRef.current = null;
          setLocked(null);
          setHover(null);
          setSticky(null);
          stickyRef.current = null;
          renderer.setHover(null, []);
          renderer.setPointer(-1, -1);
        } else if (hit.point !== undefined) {
          const target = { region: hit.region, point: hit.point };
          const next = { target, x: event.clientX, y: event.clientY };
          lockedRef.current = null;
          setLocked(null);
          setHover(null);
          setSticky(next);
          stickyRef.current = next;
          setLastPointer({ x: event.clientX, y: event.clientY });
          renderer.setHover(target, relationsFor(hit.region));
        } else {
          setHover(null);
          setSticky(null);
          stickyRef.current = null;
          setLastPointer({ x: event.clientX, y: event.clientY });
          lockRef.current(hit);
        }
        return;
      }
      /* The release hands the drag's own speed to the coast, capped, so a flick carries. */
      rig.vYaw = Math.max(-1.75, Math.min(1.75, yawSpeed));
      rig.vScroll = Math.max(-SEA_FEEL.scrollMax, Math.min(SEA_FEEL.scrollMax, scrollSpeed));
      setCursor(false);
    };

    const onPointerLeave = () => {
      if (stickyRef.current === null) renderer.setPointer(-1, -1);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target !== null && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA'
        || target.isContentEditable)) return;
      shift = event.shiftKey;
      const key = event.key.toLowerCase();
      if (key === 'arrowup' || key === 'arrowdown' || key === 'arrowleft' || key === 'arrowright') {
        event.preventDefault();
        keys.add(key);
      } else if (key === 'q' || key === 'z') {
        notch(rig, -1);
      } else if (key === 'e' || key === 'c') {
        notch(rig, 1);
      } else if (key === 'escape') {
        lockedRef.current = null;
        setLocked(null);
        setSticky(null);
        stickyRef.current = null;
        applyHover(null, 0, 0);
      }
    };

    const onKeyUp = (event: KeyboardEvent) => {
      shift = event.shiftKey;
      keys.delete(event.key.toLowerCase());
    };

    const onBlur = () => {
      shift = false;
      keys.clear();
    };

    /* ── the compass ───────────────────────────────────────────────────────── */

    const compass = compassRef.current;
    const compassCtx = compass === null ? null : compass.getContext('2d');
    const compassDpr = Math.min(2, window.devicePixelRatio || 1);
    let lastBearing = Number.NaN;

    /** Draw the dial: a fixed view pointer over a ring that turns with the wall. */
    const drawCompass = (bearing: number): void => {
      if (compass === null || compassCtx === null) return;
      const size = COMPASS_SIZE;
      if (compass.width !== size * compassDpr) {
        compass.width = size * compassDpr;
        compass.height = size * compassDpr;
      }
      const ctx = compassCtx;
      ctx.setTransform(compassDpr, 0, 0, compassDpr, 0, 0);
      ctx.clearRect(0, 0, size, size);
      const c = size / 2;

      /* The control's face. */
      ctx.beginPath();
      ctx.arc(c, c, c - 2, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(6, 10, 16, 0.78)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(225, 238, 250, 0.22)';
      ctx.lineWidth = 1;
      ctx.stroke();

      /* The dial turns under a fixed view pointer; the star is the dial's zero. */
      ctx.save();
      ctx.translate(c, c);
      ctx.rotate((-bearing * Math.PI) / 180);
      for (let deg = 0; deg < 360; deg += 15) {
        const major = deg % 45 === 0;
        const a = (deg * Math.PI) / 180 - Math.PI / 2;
        const outer = c - 7;
        const inner = outer - (major ? 8 : 4);
        ctx.strokeStyle = major ? 'rgba(225,238,250,0.5)' : 'rgba(225,238,250,0.22)';
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * inner, Math.sin(a) * inner);
        ctx.lineTo(Math.cos(a) * outer, Math.sin(a) * outer);
        ctx.stroke();
      }
      /* A gold bead marks the star's meridian; the needle points at it. */
      ctx.beginPath();
      ctx.arc(0, -(c - 11), 2.4, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,226,155,0.95)';
      ctx.fill();

      ctx.beginPath();
      ctx.moveTo(0, -(c - 20));
      ctx.lineTo(4, 0);
      ctx.lineTo(-4, 0);
      ctx.closePath();
      ctx.fillStyle = 'rgba(255,226,155,0.95)';
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(0, c - 20);
      ctx.lineTo(4, 0);
      ctx.lineTo(-4, 0);
      ctx.closePath();
      ctx.fillStyle = 'rgba(225,238,250,0.32)';
      ctx.fill();
      ctx.restore();

      /* The view pointer stays at the top; the dial turns beneath it. */
      ctx.beginPath();
      ctx.moveTo(c, 2);
      ctx.lineTo(c - 4, 9);
      ctx.lineTo(c + 4, 9);
      ctx.closePath();
      ctx.fillStyle = 'rgba(255,232,180,0.9)';
      ctx.fill();

      ctx.beginPath();
      ctx.arc(c, c, 2, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(232,240,248,0.85)';
      ctx.fill();
    };
    drawCompass(0);
    resetRef.current = resetPose;

    host.addEventListener('wheel', onWheel, { passive: false });
    host.addEventListener('pointerdown', onPointerDown);
    host.addEventListener('pointermove', onPointerMove);
    host.addEventListener('pointerup', onPointerUp);
    host.addEventListener('pointercancel', onPointerUp);
    host.addEventListener('pointerleave', onPointerLeave);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);

    /* ── the frame clock ───────────────────────────────────────────────────── */

    const started = performance.now();
    let last = started;
    /* The pose and the scene revision of the last drawn frame. A settled pose with no
       scene change draws nothing: the compositor keeps the frame already on screen, so a
       still wall costs no GPU. Springs converge without ever landing, which is why the
       comparison has a sub-pixel bound rather than waiting for equality. */
    let drawnPose: SeaPose | null = null;
    let drawnRevision = -1;
    /* A restored tab starts with a fresh frame, because a hidden canvas may come back blank. */
    const onVisible = () => {
      if (!document.hidden) drawnPose = null;
    };
    document.addEventListener('visibilitychange', onVisible);
    renderer.setAnimationLoop(() => {
      const now = performance.now();
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;

      if (keys.has('arrowup')) rig.vScroll += SEA_FEEL.scrollAccel * dt;
      if (keys.has('arrowdown')) rig.vScroll -= SEA_FEEL.scrollAccel * dt;
      if (keys.has('arrowleft')) rig.vYaw -= (SEA_FEEL.yawAccel * Math.PI / 180) * dt;
      if (keys.has('arrowright')) rig.vYaw += (SEA_FEEL.yawAccel * Math.PI / 180) * dt;

      stepRig(rig, {
        dt,
        sprint: shift,
        hold: dragging,
        locked: lockedRef.current === null
          ? null
          : { y: lockedRef.current.rise, yaw: lockedRef.current.yaw },
        reduced: still,
        momentum: momentumOf(treeCac[SEA_MOMENTUM_KEY]),
      });
      const view: SeaPose = {
        camY: rig.camY * DEG_PER_UNIT,
        phi: rig.phi,
        pitch: leanedPitch(rig, still) + levelPitch(rig.camY),
        roll: rig.roll,
        fov: rig.fov,
      };
      renderer.setView(view);
      const bearing = ((-rig.phi * DEG) % 360 + 360) % 360;
      if (!(Math.abs(bearing - lastBearing) < 0.05)) {
        lastBearing = bearing;
        drawCompass(bearing);
      }
      const poseStill = drawnPose !== null && poseSettled(drawnPose, view);
      const redraw = !poseStill || drawnRevision !== renderer.revision;
      if (redraw) {
        renderer.render(dt, (now - started) / 1000);
        drawnPose = view;
        drawnRevision = renderer.revision;
      }
      noteSeaFrame(dt * 1000, redraw, poseStill);
    });

    return () => {
      renderer.setAnimationLoop(null);
      document.removeEventListener('visibilitychange', onVisible);
      observer?.disconnect();
      window.removeEventListener('resize', size);
      reduced.removeEventListener('change', onReduced);
      host.removeEventListener('wheel', onWheel);
      host.removeEventListener('pointerdown', onPointerDown);
      host.removeEventListener('pointermove', onPointerMove);
      host.removeEventListener('pointerup', onPointerUp);
      host.removeEventListener('pointercancel', onPointerUp);
      host.removeEventListener('pointerleave', onPointerLeave);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      renderer.dispose();
      rendererRef.current = null;
      resetRef.current = () => {};
      if (canvas.parentElement === mount) mount.removeChild(canvas);
    };
  }, [relationsFor]);

  /* The card follows the pointer, stays on a tapped star, and stays on a locked tag. */
  const active = hover ?? sticky
    ?? (locked === null ? null : { target: locked.target, ...lastPointer });
  const activeRegion = active?.target.region;
  const shownBox = cardBox ?? (active === null ? null : defaultCardBox(active));
  const boxRef = useRef<CardBox | null>(null);
  boxRef.current = shownBox;
  useEffect(() => { setCardBox(null); }, [activeRegion?.tag]);

  const beginCardDrag = useCallback((event: React.PointerEvent<HTMLElement>,
    mode: CardDrag['mode']): void => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const box = boxRef.current;
    if (box === null) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    cardDragRef.current = { id: event.pointerId, mode, x: event.clientX, y: event.clientY, box };
  }, []);
  const moveCard = useCallback((event: React.PointerEvent<HTMLElement>): void => {
    const drag = cardDragRef.current;
    if (drag === null || drag.id !== event.pointerId) return;
    event.preventDefault();
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    setCardBox(clampCard(drag.mode === 'move'
      ? { ...drag.box, x: drag.box.x + dx, y: drag.box.y + dy }
      : { ...drag.box, w: drag.box.w + dx, h: drag.box.h + dy }));
  }, []);
  const endCardDrag = useCallback((event: React.PointerEvent<HTMLElement>): void => {
    const drag = cardDragRef.current;
    if (drag === null || drag.id !== event.pointerId) return;
    cardDragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  }, []);
  const activeRelations = useMemo(
    () => relationsFor(activeRegion),
    [activeRegion, relationsFor],
  );

  const card = useMemo(() => {
    if (active === null || activeRegion === undefined || !foreground
      || shownBox === null) return null;
    const region = activeRegion;
    const nature = kindLabel(region.nature);
    const reach = kindLabel(region.reach);
    const point = active.target.point;

    return (
      <div
        style={{
          ...CARD, left: shownBox.x, top: shownBox.y,
          width: shownBox.w, height: shownBox.h,
        }}
        role="group"
        aria-live="polite"
      >
        <div
          style={CARD_HEAD}
          title="drag to move"
          onPointerDown={(event) => beginCardDrag(event, 'move')}
          onPointerMove={moveCard}
          onPointerUp={endCardDrag}
          onPointerCancel={endCardDrag}
        >
          <div style={CARD_TAG}>{`#${region.tag}`}</div>
          <div style={CARD_META}>
            {`${reach.mark} ${reach.label} · ${nature.label} · ${region.weight} row(s)`}
            {region.lambda === undefined ? '' : ` · λ ${region.lambda.toFixed(2)}`}
            {region.top === undefined ? '' : ` · ${region.top}`}
            {region.burst === undefined ? '' : ` · burst #${region.burst}`}
            {region.trend === undefined ? '' : ` · trend ${region.trend.toFixed(2)}`}
          </div>
        </div>
        <div style={CARD_BODY}>
        {activeRelations.length > 0 && (
          <>
            <div style={CARD_SECTION}>relations</div>
            <div style={CARD_REL}>
              {activeRelations.slice(0, 10).map((relation) => {
                const jumpable = regionTags.has(relation.tag);
                return (
                  <button
                    key={`${relation.kind}:${relation.tag}`}
                    type="button"
                    style={relationStyle(relation.kind, jumpable)}
                    title={jumpable
                      ? `${relation.kind} ${relation.tag} — jump to its region`
                      : `${relation.kind} ${relation.tag} — not on the wall`}
                    aria-disabled={!jumpable}
                    onClick={() => jumpToRegion(relation.tag)}
                  >
                    {`· ${relation.tag}`}
                  </button>
                );
              })}
            </div>
          </>
        )}
        {point !== undefined && (
          <>
            <div style={CARD_SECTION}>link</div>
            <button
              type="button"
              style={point.action === 'link' ? CARD_ROW : CARD_ROW_EDITOR}
              title={point.text}
              onClick={() => openRow(point.ref, point.action)}
            >
              {`${point.action === 'link' ? '↗' : '✎'} ${point.label}`}
            </button>
          </>
        )}
        {region.rows.length > 0 && (
          <>
            <div style={CARD_SECTION}>rows kept</div>
            {region.rows.slice(0, 8).map((row) => (
              <button
                key={row.key}
                type="button"
                style={row.action === 'link' ? CARD_ROW : CARD_ROW_EDITOR}
                title={row.text}
                onClick={() => openRow(row.ref, row.action)}
              >
                {`${row.action === 'link' ? '↗' : '✎'} ${row.label}`}
              </button>
            ))}
            {region.rows.length > 8 && (
              <div style={{ color: 'rgba(232,240,248,0.4)' }}>{`+${region.rows.length - 8} more`}</div>
            )}
          </>
        )}
        {region.rows.length === 0 && (
          <div style={{ color: 'rgba(232,240,248,0.4)', marginTop: 4 }}>
            no links kept this tag
          </div>
        )}
        </div>
        <div
          style={CARD_GRIP}
          title="resize"
          onPointerDown={(event) => beginCardDrag(event, 'resize')}
          onPointerMove={moveCard}
          onPointerUp={endCardDrag}
          onPointerCancel={endCardDrag}
        />
      </div>
    );
  }, [
    active, activeRegion, activeRelations, beginCardDrag, endCardDrag, foreground,
    jumpToRegion, moveCard, openRow, regionTags, shownBox,
  ]);

  if (failure !== null) return <div style={NOTICE}>{failure}</div>;

  return (
    <>
      <div
        ref={hostRef}
        className="sea-root"
        style={{ ...MOUNT, pointerEvents: foreground ? 'auto' : 'none' }}
      >
        <div ref={mountRef} style={CANVAS_HOST} />
      </div>
      <canvas
        ref={compassRef}
        className="sea-compass"
        style={{ ...COMPASS, display: foreground ? 'block' : 'none' }}
        width={COMPASS_SIZE}
        height={COMPASS_SIZE}
        role="button"
        aria-label="Return to the star and sea level"
        title="Return to the star and sea level"
        onClick={() => resetRef.current()}
      />
      {card}
      {tags.length === 0 && (
        <div style={WAITING}>
          {seedError === null ? 'reading star.tagger.md…' : `could not read the table: ${seedError}`}
        </div>
      )}
    </>
  );
}
