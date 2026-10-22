/**
 * SeaView.tsx — the sea as a wall: a tag canvas on a cylinder, the star at sea level, and the
 * camera body that is dragged through it.
 *
 * `star.tagger.md`'s generated taxonomy is packed once by `seaWall.buildWall` into rectangles
 * on the cylinder: the pinned headings keep the central column below the star, each cluster's
 * clouds fill the wall above or below sea level according to the pin they answer for, and every
 * row a tag was kept by is a point inside its region. Nothing is sampled or invented.
 *
 * The camera is the one the feel module describes: a spring-damped body, scroll and yaw that
 * coast, five pitch detents, and a field of view the wheel opens. Sea level also tilts the
 * aim, up above the horizon and down below it, so a dive looks into the deep while the star
 * and its ring stay overhead. Sea level is rise 0; the first pinned heading stands there
 * under a star whose ring runs round the whole cylinder.
 * Above the horizon the canvas is almost black and catches the star's light; below it is tinted
 * and readable.
 *
 * The only DOM is the hover card. It names the tag, says what the taxonomy calls it, lists the
 * relations the table itself records, and offers the rows that can be opened. A pinch splits
 * into its horizontal and vertical parts and moves the wall's spacing apart; labels keep their
 * size.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { daRead, treeCac } from '../sdb';
import {
  STAR_TAGGER_REF, parseStarTaggerDoc, starSetupFingerprint,
} from '../starTagger';
import { ensureStarTaggerRow, writeStarTaggerTrace } from './starTaggerRun';
import { loadPinGraph, type PinGraphSeed } from './seaPinGraph';
import { restTagStore } from './restGrouper';
import {
  kindLabel, parseTaxonomyDoc, relationsOf, seaRowsByTag, seaTagPool, graphFromTags,
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

/** Where the sea is put: full screen, behind the app's own chrome. */
const MOUNT: React.CSSProperties = {
  position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', zIndex: 0,
  userSelect: 'none',
};

/** The canvas host inside that element. */
const CANVAS_HOST: React.CSSProperties = { position: 'absolute', inset: 0 };

/** The hover card. */
const CARD: React.CSSProperties = {
  position: 'fixed', zIndex: 3, width: 340, maxHeight: 320, overflow: 'hidden',
  padding: '9px 11px', borderRadius: 10, color: 'rgba(232,240,248,0.94)',
  background: 'rgba(5,8,13,0.9)', border: '1px solid rgba(255,255,255,0.14)',
  backdropFilter: 'blur(10px)', fontSize: 12, lineHeight: '16px',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  boxShadow: '0 12px 40px rgba(0,0,0,0.55)',
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

const relationStyle = (kind: TagRelation['kind']): React.CSSProperties => ({
  padding: '1px 5px', borderRadius: 4, fontSize: 10,
  color: kind === 'pin' ? '#ffe6b8'
    : kind === 'theme' ? '#c7a6ff'
      : kind === 'burst' ? '#ffb27a'
        : kind === 'alias' ? '#d6d9ff' : '#8fe3ff',
  background: 'rgba(255,255,255,0.06)',
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
 * The sea: the tag wall, the camera body, the star, and the hover card.
 *
 * @param props.foreground whether the sea is the route in front; a route that draws its own
 *        panes keeps its own pointer, so the sea only takes it here
 * @returns the canvas host and the hover card
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
  const openRef = useRef<(ref: string, action: SeaAction) => void>(() => {});
  const lockRef = useRef<(hit: SeaWallPick) => void>(() => {});
  const applyRef = useRef<() => void>(() => {});
  const spacingRef = useRef({ x: 1, y: 1 });

  const [failure, setFailure] = useState<string | null>(null);
  const [seedError, setSeedError] = useState<string | null>(null);
  const [seed, setSeed] = useState<PinGraphSeed | null>(null);
  const [hover, setHover] = useState<HoverState | null>(null);
  const [locked, setLocked] = useState<LockState | null>(null);
  const [lastPointer, setLastPointer] = useState(NO_POINTER);

  /* The tagger row is the wall's only configuration: Setup decides the seed, and the
     generated section is both the tag table and the relation lists the card reads. */
  const taggerRow = useLiveQuery(async () => (await daRead(STAR_TAGGER_REF, 'md')) ?? null, [], null);
  const tagger = useMemo(
    () => (taggerRow === null ? null : parseStarTaggerDoc(taggerRow.txt)),
    [taggerRow?.txt],
  );
  const doc = useMemo(
    () => (tagger === null ? { tags: [], relations: NO_RELATIONS } : parseTaxonomyDoc(tagger.taxonomy)),
    [tagger?.taxonomy],
  );
  const tags = useMemo(() => seaTagPool(doc.tags, seed), [doc.tags, seed]);
  const rowsByTag = useMemo(
    () => (seed === null ? new Map<string, SeaRow[]>() : seaRowsByTag(seed)),
    [seed],
  );
  const graph = useMemo(
    () => {
      const base = seed?.graph ?? graphFromTags(tags, doc.relations);
      /* The generated table is the durable reading, so a pinned reach there roots the wall
         even when the pin cards themselves are not readable in this profile. */
      const pinned = tags.filter((tag) => tag.reach === 'pinned').map((tag) => tag.tag);
      if (pinned.every((tag) => base.roots.has(tag))) return base;
      const roots = new Set(base.roots);
      for (const tag of pinned) roots.add(tag);
      return { ...base, roots };
    },
    [seed, tags, doc.relations],
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
        ...(seed === null ? {} : { recency: (tag: string) => seed.recency.get(tag) }),
      })),
    [graph, tags, rowsByTag, seed],
  );

  useEffect(() => { rowsRef.current = rowsByTag; }, [rowsByTag]);
  useEffect(() => { graphRef.current = graph; }, [graph]);
  useEffect(() => { relationsRef.current = doc.relations; }, [doc.relations]);
  useEffect(() => { lockedRef.current = locked; }, [locked]);
  useEffect(() => {
    if (!foreground) setHover(null);
  }, [foreground]);

  const openRow = useCallback((ref: string, action: SeaAction) => {
    openRowOf(navigate, ref, action);
  }, [navigate]);
  useEffect(() => { openRef.current = openRow; }, [openRow]);

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

  const toggleLock = useCallback((hit: SeaWallPick) => {
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
  useEffect(() => { lockRef.current = toggleLock; }, [toggleLock]);

  /* Seed the row once so a fresh table has a place to write the trace. */
  useEffect(() => {
    void ensureStarTaggerRow().catch((error: unknown) => {
      console.debug('[star.tagger] seed skipped', error);
    });
  }, []);

  /* Re-seed when Setup changes, or once for a `reset: yes`. */
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
    loadPinGraph(setup)
      .then((loaded) => {
        if (!live) return;
        setSeed(loaded);
        if (restTagStore.version === 0) {
          restTagStore.set(loaded.reports, loaded.rows, loaded.pins);
        }
        void writeStarTaggerTrace(loaded, loaded.setup, loaded.timings).catch((error: unknown) => {
          console.debug('[star.tagger] trace skipped', error);
        });
      })
      .catch((error: unknown) => {
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
    let clickTimer: number | null = null;
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
        const held = lockedRef.current;
        if (held !== null) applyLock(held.target);
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
      renderer.setHover(null, []);
    };

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) {
        /* Ctrl or ⌘ with the wheel opens the vertical spacing only; the labels keep their
           size, so the wall reads as a wider or tighter canvas rather than a zoomed view. */
        const spacing = spacingRef.current;
        spacing.y = Math.min(SPACING_MAX, Math.max(SPACING_MIN,
          spacing.y * Math.exp(-event.deltaY * 0.0015)));
        renderer.setSpacing(spacing.x, spacing.y);
        return;
      }
      wheelScroll(rig, event.deltaY * 2);
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
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
      if (moved > CLICK_SLOP) setHover(null);
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
          if (clickTimer !== null) {
            window.clearTimeout(clickTimer);
            clickTimer = null;
          }
          resetPose();
          return;
        }
        const rect = canvas.getBoundingClientRect();
        const hit = renderer.pick(event.clientX - rect.left, event.clientY - rect.top);
        if (clickTimer !== null) window.clearTimeout(clickTimer);
        /* A single click waits out the double-click window: the same gesture must not both
           open a link and carry the camera home. */
        clickTimer = window.setTimeout(() => {
          clickTimer = null;
          if (hit === null) {
            lockedRef.current = null;
            setLocked(null);
            renderer.setHover(null, []);
          } else if (hit.point !== undefined) {
            openRef.current(hit.point.ref, hit.point.action);
          } else {
            lockRef.current(hit);
          }
        }, 300);
        return;
      }
      /* The release hands the drag's own speed to the coast, capped, so a flick carries. */
      rig.vYaw = Math.max(-1.75, Math.min(1.75, yawSpeed));
      rig.vScroll = Math.max(-SEA_FEEL.scrollMax, Math.min(SEA_FEEL.scrollMax, scrollSpeed));
      setCursor(false);
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
      if (clickTimer !== null) window.clearTimeout(clickTimer);
      observer?.disconnect();
      window.removeEventListener('resize', size);
      reduced.removeEventListener('change', onReduced);
      host.removeEventListener('wheel', onWheel);
      host.removeEventListener('pointerdown', onPointerDown);
      host.removeEventListener('pointermove', onPointerMove);
      host.removeEventListener('pointerup', onPointerUp);
      host.removeEventListener('pointercancel', onPointerUp);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      renderer.dispose();
      rendererRef.current = null;
      resetRef.current = () => {};
      if (canvas.parentElement === mount) mount.removeChild(canvas);
    };
  }, [relationsFor]);

  /* The card follows the pointer, and stays on the locked tag when the pointer has left. */
  const active = hover ?? (locked === null ? null : { target: locked.target, ...lastPointer });
  const activeRegion = active?.target.region;
  const activeRelations = useMemo(
    () => relationsFor(activeRegion),
    [activeRegion, relationsFor],
  );

  const card = useMemo(() => {
    if (active === null || activeRegion === undefined || !foreground) return null;
    const left = Math.max(8, Math.min(active.x + 18, window.innerWidth - 356));
    const top = Math.max(8, Math.min(active.y + 18, window.innerHeight - 330));
    const region = activeRegion;
    const nature = kindLabel(region.nature);
    const reach = kindLabel(region.reach);
    const point = active.target.point;

    return (
      <div style={{ ...CARD, left, top }} role="group" aria-live="polite">
        <div style={CARD_TAG}>{`#${region.tag}`}</div>
        <div style={CARD_META}>
          {`${reach.mark} ${reach.label} · ${nature.label} · ${region.weight} row(s)`}
          {region.lambda === undefined ? '' : ` · λ ${region.lambda.toFixed(2)}`}
          {region.top === undefined ? '' : ` · ${region.top}`}
          {region.burst === undefined ? '' : ` · burst #${region.burst}`}
        </div>
        {activeRelations.length > 0 && (
          <>
            <div style={CARD_SECTION}>relations</div>
            <div style={CARD_REL}>
              {activeRelations.slice(0, 10).map((relation) => (
                <span key={`${relation.kind}:${relation.tag}`} style={relationStyle(relation.kind)}>
                  {`${relation.kind} · ${relation.tag}`}
                </span>
              ))}
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
    );
  }, [active, activeRegion, activeRelations, foreground, openRow]);

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
