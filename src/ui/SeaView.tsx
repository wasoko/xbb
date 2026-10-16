/**
 * SeaView.tsx — the sea: the tag table wrapped on a cylinder.
 *
 * A camera on the axis of a cylinder whose wall is a grid, with the tags the pin reading kept
 * hung on it as stars. The camera only ever turns on the spot and pans along the axis: a
 * horizontal drag carries the wall's 360 degrees around under the pointer, a vertical gesture
 * pans the wall past it, and letting go leaves the pan coasting. Both halves are a grab: the
 * wall follows the pointer rather than running away from it, so pulling right reveals what was
 * to the left and pulling down reveals what was above. The vertical gesture is a pan rather
 * than a turn because the wall has no end to turn over — the sphere this replaced dragged its
 * bands across a pole and bunched them there — which is also what makes the vertical axis worth
 * filling: the layout puts a tag higher the newer its evidence is and lower the narrower it is.
 *
 * The wheel pans with the same glide, and Ctrl or ⌘ with the wheel narrows the field of view
 * and with it the grid. A click selects the grid cell under the pointer, which outlines it and
 * lists the tags inside it.
 *
 * The wall is read by how far a tag is from the curated half (`restGraph.pinReach`): the pin
 * cards' own headings hold a column down the middle of the wall, their spellings in a band
 * under each, and every other tag fills the two strips beside them, packed so that the wall a
 * tag owns is the rows that kept it. The seed is `seaPinGraph.loadPinGraph()` — the pins plus
 * the newest rows, scored with `qarf` — rather than the rest list's pass, because a reading of
 * the whole window is what makes a hop a statement about the table instead of about the rows
 * on screen.
 *
 * What a region shows is decided by the screen rather than by the table, so the frame loop
 * measures every region's own box and publishes the tier each one earned; React draws the
 * tier. A region with room carries its tag's name across it, a region with room for the rows
 * carries those too, and a region too small or too far into the field is a point that opens on
 * a hover or a tap. See `SeaRegions.tsx` for what is drawn and `seaRegion.ts` for the packing
 * and the tiers.
 *
 * The sea is a background, not a page: it is a fixed canvas behind `.content`, and the app's
 * own panes are translucent over it. Only the sea's route hands it the pointer, so a click
 * reaches the wall exactly when nothing is drawn over it. The readouts follow that rule too:
 * they are the sky's own chrome, hung below the user bar rather than under it, and shown only
 * where the sea is the route in front.
 *
 * ## The renderer
 *
 * `three` has been WebGL 2 only since r163: the renderer asks for a `webgl2` context
 * itself and never checks what it was handed, so giving it a `webgl` context leaves it
 * initialising 2-only state over a 1-only context. There is therefore no WebGL 1 branch
 * here — an older browser gets a notice instead of a broken canvas, and the capability is
 * read off `WebGL2RenderingContext` rather than by probing our own canvas, because a
 * `getContext` call pins that canvas to the context it returns and the renderer's own
 * attributes would then be ignored.
 *
 * The loop is `renderer.setAnimationLoop`, which is the renderer's own frame hook and the
 * one an XR or worker-backed device can drive, rather than a bare `requestAnimationFrame`
 * that outlives the renderer when the component unmounts.
 *
 * Shaders compile on the first frame instead of through `renderer.compileAsync`. That
 * call polls each material's program until it reports ready, and the star field and the
 * selected cell are swapped whenever a pass or a click lands, so a swap can dispose a
 * material the poll is still holding and the call throws instead of resolving. A
 * background that compiles on its own first frame costs one frame and cannot do that.
 *
 * The canvas belongs to the mount rather than to React. React runs an effect twice on a
 * first render, and a canvas reused by both runs is one whose WebGL context the second run
 * takes over from the first; a canvas created and removed with its renderer cannot be
 * shared that way.
 *
 * The click reads its direction by unprojecting the pointer rather than by raycasting a pick
 * surface. The camera stands on the axis, so the direction from where it stands is the ray
 * that left it, and the wall it meets is the wall the stars are drawn on.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import * as THREE from 'three';
import { treeCac, type Da } from '../sdb';
import { GRAPH_REACH } from './restGraph';
import { restTagContributors, restTagStore } from './restGrouper';
import { PIN_SEED_ROWS, loadPinGraph, type PinGraphSeed } from './seaPinGraph';
import {
  cellCenter, gridSpacing, seaCell, seaLabel, seaVec, vecSea, visibleRise, wrapLon,
  type SeaCell,
} from './seaSky';
import {
  labelFontPx, regionTiers, regionsInCell, seaRegions,
  type SeaBox, type SeaRegion,
} from './seaRegion';
import { seaStars, skyLegend, type SeaStarField } from './seaStars';
import { SeaRegions, type SeaRegionView } from './SeaRegions';
import {
  SEA_MOMENTUM_KEY, flickSpeed, glideAtRest, glideRelease, glideStep, glideWheel,
  seaMotionFrom, type Glide, type SeaMotion,
} from './seaMotion';
import {
  disposeChildren, makeCellPatch, makeEdges, makeGrid, makeStars, starMaterial,
  starPositions,
} from './seaScene';

/** The cylinder the sky is drawn on. Any radius works: the camera only ever reads angles. */
const RADIUS = 100;

/** World units one degree of rise covers on the wall, so a pan is carried in the layout's own
 *  units. A star sits at `RADIUS * rise * RAD`. */
const UNIT = (RADIUS * Math.PI) / 180;

/** Degrees per radian, for the look direction and the wall's own units. */
const RAD = Math.PI / 180;

/**
 * Field of view the sea opens on, and the range the wheel walks.
 *
 * It opens wide enough to hold the spine's window on both sides — a pin, its spellings, and the
 * wall behind them — and it stops short of 180 because the wall closes no view: near 180 degrees
 * the frustum covers hundreds of grid steps, which is a grid drawn finer than a screen can show.
 */
const FOV_START = 120;
const FOV_MIN = 1;
const FOV_MAX = 140;

/** Field of view one wheel pixel adds. */
const FOV_PER_PIXEL = 0.05;

/** Pointer travel under this, in pixels, is a click rather than a drag. */
const CLICK_SLOP = 5;

/** Milliseconds between two readings of what stands in front, so a pan does not re-render
 *  React on every frame of a glide. */
const VIEW_MS = 120;

/** Degrees a region's own edge may stand outside the view and still be drawn. */
const VIEW_MARGIN = 24;

/** The sky's own colour. The canvas is opaque, so this is what shows through the panes. */
const SKY_COLOR = 0x05070c;

/** Largest a star is drawn, in device pixels. */
const MAX_STAR_PIXELS = 24;

/** Tags the cell readout lists before it stops and counts the rest. */
const CELL_LIST = 24;

/** The sea's taxonomy, as a record a kind can be looked up in without a cast. */
const REACH_MARK: Record<string, { mark: string; label: string } | undefined> = GRAPH_REACH;

/** The taxonomy's own order, which is the order the readout's legend lists it in. */
const REACH_ORDER: string[] = Object.keys(GRAPH_REACH);

/** What the readout says while the seed is being read. */
const READING = `reading the newest ${PIN_SEED_ROWS} rows…`;

/** The sky before the table has been read: no stars, and nothing to scale. */
const NO_SKY: SeaStarField = { stars: [], edges: [], maxRows: 1, maxEdge: 1, kept: 0 };

/**
 * Grid bands, keyed by spacing and step count. A wheel tick or a resize would otherwise rebuild
 * the band, and a band is thousands of segments; the ladder is nine spacings and a handful of
 * step counts, so caching costs one buffer per key and takes that work out of the wheel.
 *
 * The cache is module-level and deliberately not disposed with the view: the buffers are shared
 * by any later mount, and the keys are bounded.
 */
const gridCache = new Map<string, THREE.BufferGeometry>();

/**
 * The grid band for a spacing and a step count, built once.
 *
 * @param spacing the grid's spacing in degrees
 * @param rows steps of wall the band covers
 * @returns the cached geometry
 */
function gridFor(spacing: number, rows: number): THREE.BufferGeometry {
  const key = `${spacing}:${rows}`;
  let geometry = gridCache.get(key);
  if (geometry === undefined) {
    geometry = makeGrid(spacing, RADIUS, rows);
    gridCache.set(key, geometry);
  }
  return geometry;
}

/**
 * Steps of wall a band must cover for the whole view to sit inside it.
 *
 * @param fovDeg the camera's vertical field of view in degrees
 * @param spacing the grid's spacing in degrees
 * @returns the step count, with a step either side of what the view covers
 */
const bandRows = (fovDeg: number, spacing: number): number =>
  Math.ceil(visibleRise(fovDeg) / spacing) + 2;

/**
 * What the effects that run beside the renderer need from it. The renderer owns the frame loop,
 * so the star field, the selected cell and the region boxes are swapped into a scene that stays
 * alive rather than rebuilding the whole view when any of them changes.
 *
 * Nothing here is moved by the pan: a star keeps its place on the wall and the camera travels,
 * which is what makes a cell mean the same thing before and after a pan.
 */
interface Layers {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  grid?: THREE.LineSegments;
  /** Steps of wall the grid band covers, and the spacing it was built for. */
  gridRows: number;
  gridSpacing: number;
  stars?: THREE.Points;
  edges?: THREE.LineSegments;
  cell?: THREE.Mesh;
  cellRim?: THREE.LineLoop;
  /** One element per region the loop published, placed by the frame loop. */
  regions: Map<string, HTMLDivElement>;
  /** Puts the region boxes where their regions are; set by the renderer effect, called below. */
  place?: () => void;
  /** Device pixels one world unit covers at the wall, read when stars arrive. */
  pixelFactor: number;
  /** Tags the last reading kept, for the readout. */
  count: number;
  /** The last line of the readout: the bands' own legend, or why there are none. */
  legend: string;
  /** Rewrites the readout text; set by the renderer effect, called by the two below. */
  readout?: () => void;
}

/**
 * Where the sea is put: full screen, and behind everything the app draws.
 *
 * It is one element rather than two so the whole wall answers to one set of handlers: the
 * canvas is the sky and the region layer draws the boxes over it, and a press that lands on a
 * region's own row is still a press on the wall. A press on the app's chrome is not: the bar
 * and the panels are outside this element.
 */
const MOUNT: React.CSSProperties = {
  position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', zIndex: 0,
};

/** Where the canvas is put inside that element. */
const CANVAS_HOST: React.CSSProperties = { position: 'absolute', inset: 0 };

/** The control that names the sky's own reading, in characters, is not a caption's crop:
 *  a region's own name is set from the box the loop measured. */

const HUD: React.CSSProperties = {
  color: 'rgba(230,236,244,0.75)', background: 'rgba(0,0,0,0.45)',
  backdropFilter: 'blur(6px)', padding: '5px 8px', borderRadius: 8,
  fontSize: 12, fontFamily: 'ui-monospace, monospace', whiteSpace: 'pre-wrap', maxWidth: 340,
};

const CELL_HUD: React.CSSProperties = {
  ...HUD, maxWidth: 280, maxHeight: '52vh', overflow: 'hidden',
  color: 'rgba(230,236,244,0.9)',
};

/**
 * The column the readouts are put in: under the user bar, at the sky's own right edge.
 *
 * The bar owns the top-right corner and the drag handle moves it, so the column starts below
 * the box the bar publishes instead of below a height written here — the gap is the one the
 * bar's own panels keep. Both readouts hang in the column in order, the picked cell under the
 * look direction, rather than at a fixed offset from each other.
 */
const READOUTS: React.CSSProperties = {
  position: 'fixed', top: 'calc(var(--userbar-bottom, 98px) + 15px)', right: 10, zIndex: 2,
  display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6,
  pointerEvents: 'none',
};

/** The same column while the page draws panes of its own over the sky: a route with its own
 *  content keeps its own readouts, so the sky's are out of the way rather than over them. */
const READOUTS_HIDDEN: React.CSSProperties = { ...READOUTS, display: 'none' };

const NOTICE: React.CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 0, display: 'flex', alignItems: 'center',
  justifyContent: 'center', color: 'rgba(230,236,244,0.55)', fontSize: 13,
  background: 'rgba(5,7,12,1)', textAlign: 'center', padding: 24,
};

/**
 * The sea's canvas, its input and its readout.
 *
 * @param props.foreground whether the sea is the route in front: its own route is the one that
 *        leaves nothing over the wall, and the readouts are the sky's own chrome rather than a
 *        panel over a page, so a route that draws its own panes keeps its own
 * @returns the background canvas, a look-direction readout, and the last selected cell's
 *          tags when a cell is selected
 */
export function SeaView({ foreground }: { foreground: boolean }) {
  const navigate = useNavigate();
  /* The wall's own element: the canvas and the region boxes over it, so one set of handlers
     answers for the grid and for a press that lands on a region's row alike. */
  const hostRef = useRef<HTMLDivElement | null>(null);
  const mountRef = useRef<HTMLDivElement | null>(null);
  const lookRef = useRef<HTMLDivElement | null>(null);
  const layersRef = useRef<Layers | null>(null);  const [failure, setFailure] = useState<string | null>(null);
  /* Why the sky is empty, when it is: the seed is four times the list's own window, so a
     read that never lands is what a fresh profile or an unreadable table looks like. */
  const [seedError, setSeedError] = useState<string | null>(null);
  const [seed, setSeed] = useState<PinGraphSeed | null>(null);
  /*
   * The regions that stand in front, with the tier each was given when the loop last read
   * them. React renders what the loop published rather than what the camera is doing, which is
   * why a pan costs style writes and only a change of tier costs a render.
   */
  const [views, setViews] = useState<SeaRegionView[]>([]);
  /*
   * The last cell picked and the regions it held when it was picked. The regions are read at
   * the pick rather than on every frame: the wall can be coasting under a picked cell, and a
   * readout that followed it would re-render the app on every frame of the glide.
   */
  const [picked, setPicked] = useState<{ cell: SeaCell; regions: SeaRegion[] } | null>(null);
  /* The click handler lives in the renderer effect, which is set up once, so it reads the
     packing through a ref rather than through whatever was in scope when it was created. */
  const regionsRef = useRef<SeaRegion[]>([]);
  /* The boxes the loop positions. React mounts and unmounts them; the loop only writes to
     the elements it is handed. */
  const regionEls = useRef(new Map<string, HTMLDivElement>());

  /*
   * The packing is a pure function of the graph, so it is built once per seed rather than per
   * frame; the tiers that decide what each region shows are the loop's own reading of the
   * screen, and they are published from there.
   */
  const regions = useMemo(
    () => (seed === null
      ? []
      : seaRegions(seed.graph, { recency: (tag) => seed.recency.get(tag) })),
    [seed],
  );
  const field = useMemo(
    () => (seed === null ? NO_SKY : seaStars(seed.graph, regions)),
    [seed, regions],
  );
  /* The rows the seed's own pass kept per tag: what a cloud region draws without a query. */
  const seedRows = useMemo(
    () => (seed === null
      ? new Map<string, Da[]>()
      : restTagContributors(seed.rows, seed.reports)),
    [seed],
  );

  useEffect(() => { regionsRef.current = regions; }, [regions]);

  const registerRegion = useCallback((tag: string, el: HTMLDivElement | null) => {
    if (el === null) regionEls.current.delete(tag);
    else regionEls.current.set(tag, el);
  }, []);

  /* A row's ref opens as an editor tab, the way the rest list's own rows do. */
  const onOpenRef = useCallback((ref: string) => {
    navigate(`/tabs?e=${encodeURIComponent(ref)}&tabs=${encodeURIComponent(ref)}`);
  }, [navigate]);

  /*
   * The seed is read once per mount: the pin cards plus the newest rows of the table,
   * scored with `qarf` and parted by how far each tag is from the curated half. Its reports
   * also become the store's first pass, which is what the userbar's suggestion zone reads
   * until the list runs a pass of its own over the rows a reader is looking at.
   */
  useEffect(() => {
    let live = true;
    loadPinGraph()
      .then((loaded) => {
        if (!live) return;
        setSeed(loaded);
        if (restTagStore.version === 0) {
          restTagStore.set(loaded.reports, loaded.rows, loaded.pins);
        }
      })
      .catch((error: unknown) => {
        /* A table that cannot be read leaves the grid and the readout, which is
           everything the sea owns that is not the table's. */
        console.debug('[sea] seed skipped', error);
        if (live) setSeedError(error instanceof Error ? error.message : String(error));
      });
    return () => { live = false; };
  }, []);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const canvas = document.createElement('canvas');
    canvas.className = 'sea-canvas';
    canvas.style.touchAction = 'none';
    mount.appendChild(canvas);

    if (typeof WebGL2RenderingContext === 'undefined') {
      mount.removeChild(canvas);
      setFailure('This browser has no WebGL 2, so the sea cannot be drawn.');
      return;
    }

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        canvas, antialias: true, alpha: false, powerPreference: 'high-performance',
      });
    } catch (error) {
      /* A driver that advertises WebGL 2 and then refuses the context leaves the page
         with its own panes, which is everything the sea was for. */
      console.warn('[sea] renderer refused', error);
      mount.removeChild(canvas);
      setFailure('The graphics context could not be created, so the sea cannot be drawn.');
      return;
    }
    renderer.setClearColor(SKY_COLOR, 1);

    const camera = new THREE.PerspectiveCamera(FOV_START, 1, 0.1, RADIUS * 4);
    camera.position.set(0, 0, 0);
    camera.up.set(0, 1, 0);

    const scene = new THREE.Scene();
    const layers: Layers = {
      /* The very map the region elements register in, so the loop places the boxes React
         mounted rather than a second set of its own. */
      renderer, scene, camera, gridRows: 0, gridSpacing: 0, regions: regionEls.current,
      pixelFactor: 1, count: 0, legend: READING,
    };
    layersRef.current = layers;

    /* The look direction, the pan and the grid are read by the input handlers and by every
       frame, so they live in the closure rather than in React state: a wheel tick or a
       coasting frame must not re-render the app around it. */
    let yaw = 0;
    let fov = FOV_START;
    let spacing = gridSpacing(fov);
    /* When the loop last read what stands in front, and the reading it published, so a pan
       costs style writes and only a change of kind costs a render. */
    let publishedAt = 0;
    let published = '';
    /* The tree carries how much momentum the reader wants; absent, it is the shipped one. */
    const motion: SeaMotion = seaMotionFrom(treeCac[SEA_MOMENTUM_KEY]);
    /* The pan, in degrees of wall. It is the only thing a frame changes, and it is why the
       stars can keep their own places: the camera moves, the table does not. */
    let glide: Glide = { offset: 0, speed: 0 };

    const gridMaterial = new THREE.LineBasicMaterial({
      color: 0x8899aa, transparent: true, opacity: 0.32,
    });
    /** Swap the band for the current spacing and view. Its geometry is shared by every mount,
     *  so only the object changes and nothing is disposed here. */
    const buildGrid = () => {
      if (layers.grid) scene.remove(layers.grid);
      layers.gridRows = bandRows(fov, spacing);
      layers.gridSpacing = spacing;
      layers.grid = new THREE.LineSegments(gridFor(spacing, layers.gridRows), gridMaterial);
      scene.add(layers.grid);
    };

    /** Device pixels one world unit covers at the wall. The camera stands on the axis, so the
     *  wall is one radius away in every direction it looks. */
    const sizeFactor = () => {
      const h = canvas.clientHeight || window.innerHeight;
      return ((renderer.getPixelRatio() * h) / 2) / (Math.tan((fov * Math.PI) / 360) * RADIUS);
    };

    /** Publish the field of view and the star scale after either has moved. */
    const applySizing = () => {
      layers.pixelFactor = sizeFactor();
      const material = layers.stars?.material;
      if (material instanceof THREE.ShaderMaterial) {
        material.uniforms.uPixelsPerUnit.value = layers.pixelFactor;
        material.uniforms.uMaxPixels.value = MAX_STAR_PIXELS * renderer.getPixelRatio();
      }
    };

    /** Aim the camera at the meridian it has been turned to, at the height it has panned to. */
    const aim = () => {
      const y = camera.position.y;
      camera.lookAt(new THREE.Vector3(Math.sin(yaw * RAD), y, Math.cos(yaw * RAD)));
    };

    /** Put the camera where the pan has carried it, and the band with it. */
    const applyScroll = () => {
      camera.position.y = glide.offset * UNIT;
      const band = layers.grid;
      if (!band) return;
      /* The band's foot is pinned to a whole step of wall and then pulled back by half the
         band's own height, so the parallels land on the multiples of the spacing the wall
         itself defines, and stepping the foot by one spacing redraws the same pattern. */
      const step = layers.gridSpacing;
      const foot = Math.round(glide.offset / step) * step - (layers.gridRows * step) / 2;
      band.position.y = foot * UNIT;
    };

    /**
     * Put every region's box where its own rectangle lands on the wall, and publish what
     * stands in front with the tier each one earned.
     *
     * The loop owns the placement: it projects the region's four corners, writes the box the
     * corners cut, and sets the name's own size from that box. React is told only what changed
     * in kind — which regions stand in front, and what each is drawn as — so a pan writes
     * styles and a render happens only when the screen changes what a region can hold.
     */
    const placeRegions = () => {
      const packing = regionsRef.current;
      const w = canvas.clientWidth || window.innerWidth;
      const h = canvas.clientHeight || window.innerHeight;
      /* The loop calls this after a render and the pointer handlers call it between two, so
         the camera's own matrices are brought up to date here rather than assumed. */
      camera.updateMatrixWorld();
      camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
      const at = new THREE.Vector3();
      const corners = new Map<string, SeaBox>();
      const corner = (lon: number, rise: number): [number, number] | null => {
        at.set(...seaVec({ lon, rise }, RADIUS)).applyMatrix4(camera.matrixWorldInverse);
        /* A corner behind the camera has no screen position: projecting it would fold the
           wall round to the front, which is where the far side of the cylinder lives. */
        if (at.z > -RADIUS * 0.05) return null;
        const p = at.applyMatrix4(camera.projectionMatrix);
        return [(p.x * 0.5 + 0.5) * w, (-p.y * 0.5 + 0.5) * h];
      };
      for (const region of packing) {
        const el = layers.regions.get(region.tag);
        const a = corner(region.lon0, region.rise0);
        const b = corner(region.lon0, region.rise1);
        const c = corner(region.lon1, region.rise1);
        const d = corner(region.lon1, region.rise0);
        if (a === null || b === null || c === null || d === null) {
          if (el) el.style.visibility = 'hidden';
          continue;
        }
        const xs = [a[0], b[0], c[0], d[0]];
        const ys = [a[1], b[1], c[1], d[1]];
        const x0 = Math.min(...xs);
        const y0 = Math.min(...ys);
        const bw = Math.max(...xs) - x0;
        const bh = Math.max(...ys) - y0;
        if (bw < 1 || bh < 1 || x0 > w + VIEW_MARGIN || y0 > h + VIEW_MARGIN
          || x0 + bw < -VIEW_MARGIN || y0 + bh < -VIEW_MARGIN) {
          if (el) el.style.visibility = 'hidden';
          continue;
        }
        corners.set(region.tag, { w: bw, h: bh });
        if (!el) continue;
        el.style.visibility = '';
        el.style.transform = `translate(${x0.toFixed(1)}px, ${y0.toFixed(1)}px)`;
        el.style.width = `${bw.toFixed(1)}px`;
        el.style.height = `${bh.toFixed(1)}px`;
        /* The wall is a cylinder, so the box a region shows in is the quad its own corners
           cut rather than the rectangle around them. */
        el.style.clipPath = `polygon(${xs
          .map((x, i) => `${(x - x0).toFixed(1)}px ${(ys[i] - y0).toFixed(1)}px`)
          .join(', ')})`;
        el.style.fontSize = `${labelFontPx(bw, bh, region.tag.length + 1).toFixed(1)}px`;
      }
      const now = performance.now();
      if (now - publishedAt < VIEW_MS) return;
      publishedAt = now;
      const visible = packing.filter((region) => corners.has(region.tag));
      const tiers = regionTiers(visible, corners);
      const signature = visible
        .map((region) => `${region.tag}:${tiers.get(region.tag) ?? 'point'}`).join('|');
      if (signature === published) return;
      published = signature;
      setViews(visible.map((region) => ({ region, tier: tiers.get(region.tag) ?? 'point' })));
    };
    layers.place = placeRegions;

    /** Say where the wall now stands, and what is hung on it. Called by every handler that
     *  moves it, and by the effects below when what they swap changes what there is to say. */
    const readout = () => {
      if (!lookRef.current) return;
      lookRef.current.textContent = [
        seaLabel({ lon: yaw, rise: glide.offset }),
        `fov ${fov.toFixed(0)}° · grid ${spacing}° · ${layers.count} tag(s)`,
        layers.legend,
      ].filter((line) => line !== '').join('\n');
    };
    layers.readout = readout;

    const resize = () => {
      const w = canvas.clientWidth || window.innerWidth;
      const h = canvas.clientHeight || window.innerHeight;
      renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
      renderer.setSize(w, h, false);
      camera.aspect = w / Math.max(1, h);
      camera.updateProjectionMatrix();
      applySizing();
      placeRegions();
    };

    /** Re-read the view after the field of view or the pane has changed: the grid ladder and
     *  the band's own height both follow the field of view. */
    const applyView = () => {
      const wanted = gridSpacing(fov);
      if (wanted !== spacing || bandRows(fov, wanted) !== layers.gridRows) {
        spacing = wanted;
        buildGrid();
      }
      camera.fov = fov;
      camera.updateProjectionMatrix();
      applyScroll();
      applySizing();
      placeRegions();
      readout();
    };

    /* ── input ─────────────────────────────────────────────────────────────── */

    let dragging = false;
    let moved = 0;
    let lastX = 0;
    let lastY = 0;
    let pinch = 0;
    /* The last sample of a vertical drag, which is what a flick's speed is read from. */
    let dragDegrees = 0;
    let dragMs = 0;
    let dragAt = 0;

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      /* Ctrl or ⌘ with the wheel is the zoom, so the field of view and the grid ladder stay
         reachable now that a plain wheel pans the wall. */
      if (!event.ctrlKey && !event.metaKey) {
        glide = glideWheel(glide.offset, event.deltaY, motion);
        applyScroll();
        readout();
        return;
      }
      const next = Math.min(FOV_MAX, Math.max(FOV_MIN, fov + event.deltaY * FOV_PER_PIXEL));
      if (next === fov) return;
      fov = next;
      applyView();
    };

    const onPointerDown = (event: PointerEvent) => {
      dragging = true;
      moved = 0;
      dragDegrees = 0;
      dragMs = 0;
      dragAt = performance.now();
      lastX = event.clientX;
      lastY = event.clientY;
      /* A hand on the sky stops it, the way a hand on a page does. */
      glide = { offset: glide.offset, speed: 0 };
      try {
        canvas.setPointerCapture(event.pointerId);
      } catch {
        /* A pointer can be gone before this handler runs, and capturing it then throws.
           The drag still tracks the pointer while it is over the canvas. */
      }
    };

    const onPointerMove = (event: PointerEvent) => {
      if (!dragging) return;
      const dx = event.clientX - lastX;
      const dy = event.clientY - lastY;
      lastX = event.clientX;
      lastY = event.clientY;
      moved += Math.abs(dx) + Math.abs(dy);
      const perPixel = fov / Math.max(1, canvas.clientHeight);
      /* A drag moves the wall with the pointer: pulling it right reveals what was to the
         left, pulling it down reveals what was above. One pixel is one pixel of wall at the
         centre of the view, which is where the spine is, so the drag tracks the finger
         there. The vertical half is the pan, so its speed is kept to hand the wall to when
         the pointer lets go. */
      yaw = wrapLon(yaw + dx * perPixel);
      const degrees = dy * perPixel;
      glide = { offset: glide.offset + degrees, speed: 0 };
      const now = performance.now();
      dragDegrees = degrees;
      dragMs = now - dragAt;
      dragAt = now;
      aim();
      applyScroll();
      placeRegions();
      readout();
    };

    const onPointerUp = (event: PointerEvent) => {
      dragging = false;
      if (moved > CLICK_SLOP) {
        glide = glideRelease(glide.offset, flickSpeed(dragDegrees, dragMs), motion);
        readout();
      }
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    };

    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 2) return;
      event.preventDefault();
      pinch = Math.hypot(
        event.touches[0].clientX - event.touches[1].clientX,
        event.touches[0].clientY - event.touches[1].clientY,
      );
    };

    const onTouchMove = (event: TouchEvent) => {
      if (event.touches.length !== 2 || pinch === 0) return;
      event.preventDefault();
      const now = Math.hypot(
        event.touches[0].clientX - event.touches[1].clientX,
        event.touches[0].clientY - event.touches[1].clientY,
      );
      if (now === 0) return;
      fov = Math.min(FOV_MAX, Math.max(FOV_MIN, fov * (pinch / now)));
      pinch = now;
      applyView();
    };

    const onClick = (event: MouseEvent) => {
      if (moved > CLICK_SLOP) return;
      /* A press that landed on a region's own rows belongs to that row; only a press that
         landed on the wall itself picks a cell. */
      if (event.target !== canvas) return;
      const rect = canvas.getBoundingClientRect();
      const ndc = new THREE.Vector3(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
        0.5,
      );
      /* The camera stands on the axis, so the ray that left it is the direction from where
         it stands to the unprojected point — no pick mesh and no culling rule. */
      const ray = ndc.unproject(camera).sub(camera.position).normalize();
      const at = vecSea(ray.x, ray.y, ray.z, RADIUS);
      if (at === null) return;
      const cell = seaCell(at, spacing);
      setPicked({ cell, regions: regionsInCell(regionsRef.current, cell) });
    };

    /* The handlers hang on the sea's own element rather than on its canvas, because the region
       layer is drawn over the canvas rather than inside it: a press on a region's own row has
       to reach the wall's handlers the same way a press on empty grid does. */
    const host = hostRef.current ?? mount;
    host.addEventListener('wheel', onWheel, { passive: false });
    host.addEventListener('pointerdown', onPointerDown);
    host.addEventListener('pointermove', onPointerMove);
    host.addEventListener('pointerup', onPointerUp);
    host.addEventListener('pointercancel', onPointerUp);
    host.addEventListener('click', onClick);
    host.addEventListener('touchstart', onTouchStart, { passive: false });
    host.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('resize', resize);

    buildGrid();
    resize();
    aim();
    applyScroll();
    readout();

    /* The coast is stepped from the clock rather than once per frame, so a slow machine's
       longer frames carry the sky exactly as far as a fast one's short frames do. */
    let previous = performance.now();
    renderer.setAnimationLoop(() => {
      const now = performance.now();
      const elapsed = now - previous;
      previous = now;
      if (!glideAtRest(glide)) {
        glide = glideStep(glide, elapsed, motion);
        readout();
      }
      applyScroll();
      aim();
      renderer.render(scene, camera);
      placeRegions();
    });

    return () => {
      renderer.setAnimationLoop(null);
      host.removeEventListener('wheel', onWheel);
      host.removeEventListener('pointerdown', onPointerDown);
      host.removeEventListener('pointermove', onPointerMove);
      host.removeEventListener('pointerup', onPointerUp);
      host.removeEventListener('pointercancel', onPointerUp);
      host.removeEventListener('click', onClick);
      host.removeEventListener('touchstart', onTouchStart);
      host.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('resize', resize);
      /* The grid's geometry outlives this mount through the cache, so it is unlinked
         rather than disposed; everything below it belongs to this mount alone. */
      if (layers.grid) {
        scene.remove(layers.grid);
        layers.grid = undefined;
      }
      gridMaterial.dispose();
      disposeChildren(scene);
      renderer.dispose();
      mount.removeChild(canvas);
      layersRef.current = null;
    };
  }, []);

  /* The stars arrive a tick after the first paint, because they come from the table; the swap
     into the running scene keeps the renderer alive. The regions arrive with them, as React's
     own render of the packing. */
  useEffect(() => {
    const layers = layersRef.current;
    if (!layers) return;
    const { renderer, scene } = layers;

    if (layers.stars) {
      scene.remove(layers.stars);
      layers.stars.geometry.dispose();
      (layers.stars.material as THREE.Material).dispose();
      layers.stars = undefined;
    }
    if (layers.edges) {
      scene.remove(layers.edges);
      layers.edges.geometry.dispose();
      (layers.edges.material as THREE.Material).dispose();
      layers.edges = undefined;
    }
    layers.count = field.stars.length;
    layers.legend = skyLegend(field, REACH_MARK, REACH_ORDER);
    if (field.stars.length === 0) return;

    const positions = starPositions(field, RADIUS);

    const material = starMaterial();
    material.uniforms.uPixelsPerUnit.value = layers.pixelFactor;
    material.uniforms.uMaxPixels.value = MAX_STAR_PIXELS * renderer.getPixelRatio();
    const stars = new THREE.Points(makeStars(field, RADIUS, positions), material);
    layers.stars = stars;
    scene.add(stars);

    const edges = new THREE.LineSegments(
      makeEdges(field, positions, RADIUS),
      new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.14 }),
    );
    layers.edges = edges;
    scene.add(edges);

    layers.place?.();
    layers.readout?.();
  }, [field]);

  /* A seed that never landed says so where the legend goes, so an empty sky reads as an
     unread table rather than as a table with nothing in it. */
  useEffect(() => {
    const layers = layersRef.current;
    if (!layers || seedError === null) return;
    layers.legend = `could not read the table: ${seedError}`;
    layers.readout?.();
  }, [seedError]);

  /* The selected cell, as a patch on the wall plus a bright rim. A cell is named in the wall's
     own coordinates, so it stays where it was picked while the camera pans past it. */
  useEffect(() => {
    const layers = layersRef.current;
    if (!layers) return;
    const { scene } = layers;

    if (layers.cell) {
      scene.remove(layers.cell);
      layers.cell.geometry.dispose();
      (layers.cell.material as THREE.Material).dispose();
      layers.cell = undefined;
    }
    if (layers.cellRim) {
      scene.remove(layers.cellRim);
      layers.cellRim.geometry.dispose();
      (layers.cellRim.material as THREE.Material).dispose();
      layers.cellRim = undefined;
    }
    if (picked === null) return;

    const { fill, outline } = makeCellPatch(picked.cell, RADIUS);
    const patch = new THREE.Mesh(fill, new THREE.MeshBasicMaterial({
      color: 0x38bdf8, transparent: true, opacity: 0.14,
      side: THREE.DoubleSide, depthWrite: false,
    }));
    layers.cell = patch;
    scene.add(patch);

    const rim = new THREE.LineLoop(outline, new THREE.LineBasicMaterial({
      color: 0x7dd3fc, transparent: true, opacity: 0.85,
    }));
    layers.cellRim = rim;
    scene.add(rim);
  }, [picked]);
  if (failure !== null) return <div style={NOTICE}>{failure}</div>;

  return (
    <>
      {/* A decorative backdrop: the readout below carries what the sea has to say, and
          it alone is a live region, so a screen reader is not read a sky every frame. */}
      {/* The wall: a decorative canvas, and the regions drawn over it. The canvas is hidden
          from assistive technology because the readout below carries what it has to say; the
          rows over it are links, so the wrapper is not. */}
      <div ref={hostRef} className="sea-root" style={MOUNT}>
        <div ref={mountRef} style={CANVAS_HOST} aria-hidden="true" />
        <SeaRegions
          views={views}
          seed={seedRows}
          onOpenRef={onOpenRef}
          register={registerRegion}
        />
      </div>
      {/* The readout is written from the renderer's own closure, so its elements stay mounted
          and a route that draws its own panes hides the column instead of unmounting it. */}
      <div style={foreground ? READOUTS : READOUTS_HIDDEN}>
        <div ref={lookRef} style={HUD} />
        {picked !== null && picked.regions.length > 0 && (
          <div style={CELL_HUD} aria-live="polite">
            <div style={{ opacity: 0.7, marginBottom: 4 }}>
              {seaLabel(cellCenter(picked.cell), 0)} · {picked.regions.length} tag(s)
            </div>
            {picked.regions.slice(0, CELL_LIST).map((r: SeaRegion) => (
              <div key={r.tag}>
                {REACH_MARK[r.kind]?.mark ?? '·'} {r.tag}
                <span style={{ opacity: 0.55 }}> {r.rows}</span>
              </div>
            ))}
            {picked.regions.length > CELL_LIST && (
              <div style={{ opacity: 0.55 }}>+{picked.regions.length - CELL_LIST} more</div>
            )}
          </div>
        )}
      </div>
    </>
  );
}
