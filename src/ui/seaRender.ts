/**
 * seaRender.ts — the wall's three.js scene: the tag canvas, the star at sea level, its ring,
 * and the relation lines a hover pulls out of the table.
 *
 * The camera stands on the cylinder's axis, so the wall is read as directions: a place is a
 * longitude and a rise, and the content group's rotation carries the turn. The renderer owns
 * the spacing the reader pinches — every wall shader multiplies its base degrees by it — so a
 * pinch moves the tags apart without resizing a label.
 *
 * All content is real: a region exists because the packing gave a tag that wall, a point exists
 * because a row carried it, and a line exists because the table lists the relation. Above sea
 * level the canvas is almost black, with the star's light glinting off it; below it is tinted
 * and readable. The star sits over the newest pin card's column, and its ring marks the
 * horizontal direction all the way round the cylinder.
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { tagRgb } from './restCue';
import { buildTextAtlas, type AtlasSlot, type TextAtlas } from './seaAtlas';
import type { AnyNodeKind } from './restGraph';
import type { TagRelation } from './seaTags';
import type { SeaWall, WallPoint, WallRegion } from './seaWall';
import { regionOnWall } from './seaWall';
import { wrapLon } from './seaSky';

/** The cylinder the wall is drawn on, and the world units one degree of rise covers. */
export const WALL_RADIUS = 100;
const UNIT = (WALL_RADIUS * Math.PI) / 180;
const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

/** Label bake sizes, in texture pixels: a region's name is drawn as large as its cell allows. */
const LABEL_FONT_PIN = 112;
const LABEL_FONT_CLOUD = 80;

/** Instances one atlas page may hold. */
const PAGE_INSTANCES = 1024;

/**
 * Screen distance, in CSS pixels, at which two stars stop being separate targets: a pointer or
 * a finger cannot tell them apart below it, so a region denser than this shows as a cloud.
 */
const POINT_RESOLVE = 16;

/** The colours of the two halves of the sky, and the star. */
const SKY_BELOW = new THREE.Color(0x0a1620);
const SKY_ABOVE = new THREE.Color(0x000000);
const STAR_COLOR = new THREE.Color(0xffe6b0);

/** How a reach is tinted on the wall. */
const REACH_TINT: Record<string, [number, number, number]> = {
  pinned: [1.0, 0.94, 0.78],
  alias: [0.8, 0.86, 1.0],
  related: [0.46, 0.76, 0.96],
  remote: [0.36, 0.58, 0.82],
  own: [0.4, 0.52, 0.64],
};

/** A row's click colour: amber for an address, cyan for an editor jump. */
const LINK_TINT: [number, number, number] = [1.0, 0.68, 0.32];
const EDITOR_TINT: [number, number, number] = [0.55, 0.86, 1.0];

/** The relation lines' colours. */
const RELATION_TINT: Record<TagRelation['kind'], [number, number, number]> = {
  pin: [1.0, 0.94, 0.75],
  alias: [0.85, 0.85, 1.0],
  theme: [0.78, 0.55, 1.0],
  burst: [1.0, 0.58, 0.35],
  web: [0.45, 0.85, 1.0],
};

/** The camera and the content as one frame needs them. */
export interface SeaViewState {
  /** Rise the camera is level with, in degrees. */
  camY: number;
  /** Content rotation in radians. */
  phi: number;
  /** Camera pitch in degrees; positive looks up. */
  pitch: number;
  /** Camera roll in degrees. */
  roll: number;
  /** Vertical field of view in degrees. */
  fov: number;
}

/** What the pointer is over. */
export interface SeaHover {
  region?: WallRegion;
  point?: WallPoint;
}

/** What the pointer found, nearest first. */
export interface SeaWallPick extends SeaHover {
  /** Pointer-space distance, for choosing between a point and a region. */
  distance: number;
}

/** One page's instanced label buffers. */
interface LabelPage {
  mesh: THREE.Mesh;
  geometry: THREE.InstancedBufferGeometry;
  material: THREE.ShaderMaterial;
  count: number;
  anchor: Float32Array;
  uv: Float32Array;
  tint: Float32Array;
  deg: Float32Array;
  cell: Float32Array;
  attrs: THREE.InstancedBufferAttribute[];
}

/** One label instance, before it is grouped into its atlas page. */
interface LabelEntry {
  slot: AtlasSlot;
  lon: number;
  rise: number;
  /** The region's base size, in degrees; spacing does not resize the text. */
  degW: number;
  degH: number;
  /** The baked cell's own size, in texture pixels. */
  cellW: number;
  cellH: number;
  tint: [number, number, number];
  alpha: number;
}

/** The billboards' vertex shader: a label fitted to the region it names. */
const LABEL_VERTEX = `
  attribute vec2 iAnchor;
  attribute vec4 iUv;
  attribute vec4 iTint;
  attribute vec2 iDeg;
  attribute vec2 iCell;

  uniform vec2 uSpacing;
  uniform vec3 uCamLocal;
  uniform float uPxToWorld;

  varying vec2 vUv;
  varying vec4 vTint;

  void main() {
    float lon = iAnchor.x * uSpacing.x * ${RAD.toFixed(12)};
    float rise = iAnchor.y * uSpacing.y;
    vec3 anchor = vec3(sin(lon) * ${WALL_RADIUS.toFixed(1)}, rise * ${UNIT.toFixed(12)}, cos(lon) * ${WALL_RADIUS.toFixed(1)});
    vec3 toCam = uCamLocal - anchor;
    float dist = length(toCam);
    vec3 flatTo = vec3(toCam.x, 0.0, toCam.z);
    vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), normalize(flatTo)));
    /* World units one CSS pixel covers at the wall; a degree of rise is the same distance at
       every longitude, so the cell's screen size follows from its own degrees. The cell is
       fitted to fill whichever of the two the text reaches first. */
    float k = uPxToWorld * min(dist, 220.0);
    float regionW = (iDeg.x * ${RAD.toFixed(12)} * ${WALL_RADIUS.toFixed(1)}) / k;
    float regionH = (iDeg.y * ${UNIT.toFixed(12)}) / k;
    float fit = min(regionW / iCell.x, regionH / iCell.y) * 0.92;
    vec2 px = iCell * fit;
    vec3 world = anchor
      + right * ((position.x - 0.5) * px.x * k)
      - vec3(0.0, 1.0, 0.0) * ((position.y - 0.5) * px.y * k);

    vUv = vec2(mix(iUv.x, iUv.z, position.x), mix(iUv.y, iUv.w, position.y));
    vTint = iTint;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(world, 1.0);
  }
`;

/** The billboards' fragment shader: tint the baked white, with no fog over the wall. */
const LABEL_FRAGMENT = `
  uniform sampler2D uMap;
  varying vec2 vUv;
  varying vec4 vTint;

  void main() {
    vec4 tex = texture2D(uMap, vUv);
    float a = tex.a * vTint.a;
    if (a < 0.04) discard;
    gl_FragColor = vec4(tex.rgb * vTint.rgb, a);
  }
`;

/** The region fills: one instanced quad per tag, curved with the wall. */
const FILL_VERTEX = `
  attribute vec4 iRect;
  attribute vec4 iTint;
  attribute float iAbove;
  attribute float iCurated;

  uniform vec2 uSpacing;

  varying vec4 vTint;
  varying float vAbove;
  varying float vCurated;
  varying vec2 vUv;
  varying float vLon;

  void main() {
    vUv = position.xy;
    float lon = mix(iRect.x, iRect.y, position.x) * uSpacing.x * ${RAD.toFixed(12)};
    float rise = mix(iRect.z, iRect.w, position.y) * uSpacing.y;
    vLon = lon;
    vTint = iTint;
    vAbove = iAbove;
    vCurated = iCurated;
    vec3 p = vec3(sin(lon) * ${WALL_RADIUS.toFixed(1)}, rise * ${UNIT.toFixed(12)}, cos(lon) * ${WALL_RADIUS.toFixed(1)});
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

/** The region fills' fragment shader: a bordered cell, dark above sea level. */
const FILL_FRAGMENT = `
  varying vec4 vTint;
  varying float vAbove;
  varying float vCurated;
  varying vec2 vUv;
  varying float vLon;

  void main() {
    float edge = min(min(vUv.x, 1.0 - vUv.x), min(vUv.y, 1.0 - vUv.y));
    float border = 1.0 - smoothstep(0.0, 0.05, edge);
    float star = pow(max(0.0, cos(vLon)), 8.0);

    /* The cells are a quiet ground: a tint barely above the sky, with the curated column a
       shade warmer so the centre still reads as the curated half. */
    vec3 belowFill = vTint.rgb * (mix(0.02, 0.035, vCurated) + 0.015 * star);
    vec3 aboveFill = vTint.rgb * (0.004 + 0.015 * star);
    vec3 fill = mix(belowFill, aboveFill, vAbove);
    vec3 edgeCol = vTint.rgb * mix(0.08, 0.05 + 0.15 * star, vAbove);
    vec3 col = mix(fill, edgeCol, border * 0.9);
    float alpha = mix(0.08, 0.24, vAbove) + border * 0.03;
    gl_FragColor = vec4(col, alpha);
  }
`;

/** The points' vertex shader: wall coordinates scaled by the reader's spacing. */
const POINT_VERTEX = `
  attribute vec2 aAnchor;
  attribute float aSize;
  attribute vec3 aColor;
  attribute float aAlpha;
  attribute vec2 aCell;
  attribute float aCount;

  uniform vec2 uSpacing;
  uniform vec2 uPointer;
  uniform float uDpr;
  uniform float uPxToWorld;

  varying vec3 vColor;
  varying float vAlpha;
  varying float vCloud;

  void main() {
    float lon = aAnchor.x * uSpacing.x * ${RAD.toFixed(12)};
    float rise = aAnchor.y * uSpacing.y;
    vec3 p = vec3(sin(lon) * ${WALL_RADIUS.toFixed(1)}, rise * ${UNIT.toFixed(12)}, cos(lon) * ${WALL_RADIUS.toFixed(1)});
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    vec4 clip = projectionMatrix * mv;
    vec2 ndc = clip.w > 0.0 ? clip.xy / clip.w : vec2(2.0);
    float lift = max(
      1.0 - smoothstep(0.0, 0.018, distance(ndc, uPointer)),
      (1.0 - smoothstep(0.0, 0.12, length(ndc))) * 0.35
    );
    /* How far apart this region's own stars land on screen: its area in pixels divided over
       the points that fill it. Past the pointer's resolution the cell is a cloud, not a set
       of targets, so every star softens and spreads into one continuous glow. */
    float perPx = uPxToWorld * max(0.1, -mv.z);
    float cellPx = sqrt((aCell.x * ${RAD.toFixed(12)} * ${WALL_RADIUS.toFixed(1)}) * (aCell.y * ${UNIT.toFixed(12)})) / perPx;
    float spacingPx = cellPx / sqrt(max(1.0, aCount));
    float crowd = 1.0 - smoothstep(${(POINT_RESOLVE * 0.45).toFixed(1)}, ${POINT_RESOLVE.toFixed(1)}, spacingPx);
    float sizePx = mix(aSize, clamp(spacingPx * 2.6, 3.0, 64.0), crowd);
    gl_PointSize = sizePx * uDpr * (1.0 + lift * 1.4);
    vColor = aColor;
    vAlpha = aAlpha * (0.75 + lift * 1.6) * mix(1.0, 0.45, crowd);
    vCloud = crowd;
    gl_Position = clip;
  }
`;

/** The points' fragment shader: a four-ray star, washed into a cloud where a cell is crowded. */
const POINT_FRAGMENT = `
  varying vec3 vColor;
  varying float vAlpha;
  varying float vCloud;

  void main() {
    vec2 d = gl_PointCoord - vec2(0.5);
    float r = length(d) * 2.0;
    if (r > 1.0) discard;
    float core = smoothstep(0.5, 0.0, r);
    float halo = smoothstep(1.0, 0.0, r) * 0.4;
    float rays = max(0.0, 1.0 - abs(d.x) * 12.0) * max(0.0, 1.0 - abs(d.y) * 2.0)
      + max(0.0, 1.0 - abs(d.y) * 12.0) * max(0.0, 1.0 - abs(d.x) * 2.0);
    float star = core * 0.9 + rays * 0.65 + halo;
    float cloud = pow(max(0.0, 1.0 - r), 1.6);
    float a = mix(star, cloud, vCloud);
    if (a < 0.02) discard;
    gl_FragColor = vec4(vColor, vAlpha * a);
  }
`;

/** The sea-level star: a billboard with a core, a halo and four rays. */
const STAR_VERTEX = `
  uniform vec3 uCamLocal;
  uniform float uPxToWorld;
  uniform float uPx;
  varying vec2 vUv;
  void main() {
    vec3 anchor = vec3(0.0, 0.0, ${WALL_RADIUS.toFixed(1)});
    vec3 toCam = uCamLocal - anchor;
    vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), normalize(vec3(toCam.x, 0.0, toCam.z))));
    float dist = length(toCam);
    vec3 world = anchor
      + right * (position.x * uPx * uPxToWorld * dist)
      - vec3(0.0, 1.0, 0.0) * (position.y * uPx * uPxToWorld * dist);
    vUv = position.xy + 0.5;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(world, 1.0);
  }
`;

const STAR_FRAGMENT = `
  uniform vec3 uColor;
  varying vec2 vUv;
  void main() {
    vec2 d = vUv - 0.5;
    float r = length(d) * 2.0;
    float core = exp(-r * r * 42.0);
    float halo = exp(-r * 5.0) * 0.55;
    float rays = (exp(-abs(d.y) * 110.0) * exp(-abs(d.x) * 3.2)
      + exp(-abs(d.x) * 110.0) * exp(-abs(d.y) * 3.2)) * 0.6;
    float a = core + halo * 0.7 + rays;
    if (a < 0.004) discard;
    gl_FragColor = vec4(uColor * (core * 2.2 + halo + rays), min(1.0, a));
  }
`;

/** The relation lines: wall arcs, coloured by what the relation is. */
const RELATION_VERTEX = `
  attribute vec3 aColor;
  uniform vec2 uSpacing;
  varying vec3 vColor;
  void main() {
    float lon = position.x * uSpacing.x * ${RAD.toFixed(12)};
    float rise = position.y * uSpacing.y;
    vec3 p = vec3(sin(lon) * ${WALL_RADIUS.toFixed(1)}, rise * ${UNIT.toFixed(12)}, cos(lon) * ${WALL_RADIUS.toFixed(1)});
    vColor = aColor;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

const RELATION_FRAGMENT = `
  uniform float uPulse;
  varying vec3 vColor;
  void main() {
    gl_FragColor = vec4(vColor, 0.38 + uPulse * 0.18);
  }
`;

/** The post pass: a vignette and a little grain, so the wall does not read as flat cells. */
const PostShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uRes: { value: new THREE.Vector2(1, 1) },
    uTime: { value: 0 },
    uGrain: { value: 0.03 },
    uVignette: { value: 0.5 },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform vec2 uRes;
    uniform float uTime;
    uniform float uGrain;
    uniform float uVignette;
    varying vec2 vUv;
    void main() {
      vec2 d = vUv - 0.5;
      float r2 = dot(d, d);
      vec3 col = texture2D(tDiffuse, vUv).rgb;
      col *= 1.0 - smoothstep(0.12, 0.62, r2) * uVignette;
      float n = fract(sin(dot(vUv * uRes + uTime, vec2(12.9898, 78.233))) * 43758.5453);
      col += (n - 0.5) * uGrain;
      gl_FragColor = vec4(col, 1.0);
    }
  `,
};

/** A wall place in the content group's local space. */
function wallPoint(lon: number, rise: number, out: THREE.Vector3): THREE.Vector3 {
  const a = lon * RAD;
  return out.set(Math.sin(a) * WALL_RADIUS, rise * UNIT, Math.cos(a) * WALL_RADIUS);
}

/** The colour a reach is drawn with. */
function reachTint(reach: AnyNodeKind, tag: string): [number, number, number] {
  const base = REACH_TINT[reach] ?? REACH_TINT.own;
  const hue = tagRgb(tag);
  return [
    base[0] * 0.7 + hue[0] * 0.3,
    base[1] * 0.7 + hue[1] * 0.3,
    base[2] * 0.7 + hue[2] * 0.3,
  ];
}

/** The scene, its wall, and the arithmetic a pointer needs to meet a region. */
export class SeaRenderer {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly content = new THREE.Group();
  private readonly composer: EffectComposer;
  private readonly post: ShaderPass;

  private readonly sky: THREE.Mesh;
  private readonly star: THREE.Mesh;
  private readonly starMaterial: THREE.ShaderMaterial;
  private readonly fillMaterial: THREE.ShaderMaterial;
  private readonly relationMaterial: THREE.ShaderMaterial;
  private readonly highlightMaterial: THREE.ShaderMaterial;

  private fill: THREE.Mesh | null = null;
  private points: THREE.Points | null = null;
  private pointsGeometry: THREE.BufferGeometry | null = null;
  private pointsMaterial: THREE.ShaderMaterial | null = null;
  private relations: THREE.LineSegments | null = null;
  private highlight: THREE.LineSegments | null = null;

  private wall: SeaWall | null = null;
  private atlas: TextAtlas | null = null;
  private pages: LabelPage[] = [];

  private width = 1;
  private height = 1;
  private view: SeaViewState = { camY: 0, phi: 0, pitch: 0, roll: 0, fov: 48 };
  private spacing = new THREE.Vector2(1, 1);

  private hover: SeaHover | null = null;
  /** Bumped by every call that changes what the next frame would draw. */
  private sceneRevision = 0;

  /* Scratch objects, so a frame and a pick do not allocate. */
  private readonly camLocal = new THREE.Vector3();
  private readonly inverse = new THREE.Matrix4();
  private readonly toCam = new THREE.Vector3();
  private readonly flat = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly corner = new THREE.Vector3();
  private readonly projected = new THREE.Vector3();
  private readonly cameraSpace = new THREE.Vector3();
  private readonly ray = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();
  private readonly rayLocal = new THREE.Ray();
  private readonly hit = new THREE.Vector3();

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: true, alpha: false, powerPreference: 'high-performance',
    });
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1;

    this.scene.background = new THREE.Color(0x000000);
    this.scene.add(this.content);

    this.camera = new THREE.PerspectiveCamera(48, 1, 0.1, 1200);
    this.camera.position.set(0, 0, 0);
    this.camera.rotation.order = 'YXZ';
    this.camera.rotation.set(0, Math.PI, 0);

    /* The sky: a huge inward sphere. Its gradient is read off the local direction, so the
       star's glow stays at the front meridian while the content turns. */
    this.sky = new THREE.Mesh(
      new THREE.SphereGeometry(WALL_RADIUS * 5, 48, 32),
      new THREE.ShaderMaterial({
        uniforms: {
          uBelow: { value: SKY_BELOW.clone() },
          uAbove: { value: SKY_ABOVE.clone() },
          uStar: { value: STAR_COLOR.clone() },
          uCamLocal: { value: new THREE.Vector3() },
          uRingY: { value: 0 },
        },
        vertexShader: `
          varying vec3 vDir;
          uniform vec3 uCamLocal;
          void main() {
            vDir = normalize(position - uCamLocal);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: `
          uniform vec3 uBelow;
          uniform vec3 uAbove;
          uniform vec3 uStar;
          uniform float uRingY;
          varying vec3 vDir;
          void main() {
            float y = vDir.y;
            float lon = atan(vDir.x, vDir.z);
            float above = smoothstep(-0.015, 0.02, y);
            vec3 col = mix(uBelow, uAbove, above);
            /* The star's light is thrown up into the black, and kept to a thin tint below the
               horizon where the canvas is read. */
            float glow = pow(max(0.0, cos(lon)), 24.0);
            float halo = y > 0.0 ? exp(-y * 14.0) * 0.55 : exp(y * 45.0) * 0.06;
            col += uStar * glow * halo * 0.35;
            /* The sea-level ring. Every point of the circle is the same elevation from the
               camera on the axis, so the whole ring is one band of directions: uRingY is the
               sine of that elevation. A band here keeps a pixel footprint and a derivative
               wide edge; the flat annulus it replaces was seen edge-on and collapsed to a
               zero-area sliver. */
            float d = y - uRingY;
            float cosE = sqrt(max(0.0, 1.0 - uRingY * uRingY));
            float aa = max(fwidth(d), 1e-5);
            float ringHalf = ${(0.35 / WALL_RADIUS).toFixed(8)} * cosE;
            float ring = 1.0 - smoothstep(ringHalf - aa, ringHalf + aa, abs(d));
            float front = pow(max(0.0, cos(lon)), 16.0);
            col += uStar * (ring * (0.1 + front * 0.5)
              + exp(-abs(d) / (${(4 / WALL_RADIUS).toFixed(8)} * cosE)) * (0.02 + front * 0.5));
            gl_FragColor = vec4(col, 1.0);
          }
        `,
        side: THREE.BackSide,
        depthWrite: false,
        depthTest: false,
        toneMapped: false,
      }),
    );
    this.sky.renderOrder = -2;
    this.sky.frustumCulled = false;
    this.content.add(this.sky);

    /* The star over the newest pin card's column. */
    this.starMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uCamLocal: { value: new THREE.Vector3() },
        uPxToWorld: { value: 0.002 },
        uPx: { value: 168 },
        uColor: { value: STAR_COLOR.clone() },
      },
      vertexShader: STAR_VERTEX,
      fragmentShader: STAR_FRAGMENT,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    this.star = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.starMaterial);
    this.star.renderOrder = 6;
    this.star.frustumCulled = false;
    this.content.add(this.star);

    this.fillMaterial = new THREE.ShaderMaterial({
      uniforms: { uSpacing: { value: this.spacing } },
      vertexShader: FILL_VERTEX,
      fragmentShader: FILL_FRAGMENT,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    this.relationMaterial = new THREE.ShaderMaterial({
      uniforms: { uSpacing: { value: this.spacing }, uPulse: { value: 0 } },
      vertexShader: RELATION_VERTEX,
      fragmentShader: RELATION_FRAGMENT,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
      toneMapped: false,
    });

    this.highlightMaterial = new THREE.ShaderMaterial({
      uniforms: { uSpacing: { value: this.spacing }, uPulse: { value: 0.5 } },
      vertexShader: `
        attribute vec3 aColor;
        uniform vec2 uSpacing;
        varying vec3 vColor;
        void main() {
          float lon = position.x * uSpacing.x * ${RAD.toFixed(12)};
          float rise = position.y * uSpacing.y;
          vec3 p = vec3(sin(lon) * ${WALL_RADIUS.toFixed(1)}, rise * ${UNIT.toFixed(12)}, cos(lon) * ${WALL_RADIUS.toFixed(1)});
          vColor = aColor;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
        }
      `,
      fragmentShader: `
        varying vec3 vColor;
        void main() { gl_FragColor = vec4(vColor, 0.7); }
      `,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
      toneMapped: false,
    });

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.post = new ShaderPass(PostShader);
    this.composer.addPass(this.post);
    this.composer.addPass(new OutputPass());
  }

  /**
   * Swap in a new wall and bake its text.
   *
   * @param wall the packed wall
   */
  setContent(wall: SeaWall): void {
    this.wall = wall;
    this.dropLabels();
    this.atlas = buildTextAtlas(this.requests(wall));
    this.buildFills(wall);
    this.buildLabels(wall);
    this.buildPoints(wall);
    this.markDirty();
  }

  /** The count of scene changes since the renderer was built; the frame loop draws when it
   *  differs from the revision of the last drawn frame. */
  get revision(): number {
    return this.sceneRevision;
  }

  /** Record that the next frame would draw something new. */
  private markDirty(): void {
    this.sceneRevision++;
  }

  /** The atlas requests the wall needs: one fitted name per region. */
  private requests(wall: SeaWall): { key: string; text: string; fontPx: number; bold?: boolean }[] {
    const out = new Map<string, { key: string; text: string; fontPx: number; bold?: boolean }>();
    for (const region of wall.regions) {
      if (region.reflection) continue;
      const key = `t:${region.tag}`;
      if (out.has(key)) continue;
      const curated = region.reach === 'pinned' || region.reach === 'alias';
      out.set(key, {
        key,
        text: region.labelText,
        fontPx: curated ? LABEL_FONT_PIN : LABEL_FONT_CLOUD,
        bold: curated,
      });
    }
    return [...out.values()];
  }

  /** One instanced fill per region: the treemap cell itself. */
  private buildFills(wall: SeaWall): void {
    if (this.fill !== null) {
      this.content.remove(this.fill);
      this.fill.geometry.dispose();
      this.fill = null;
    }
    const regions = wall.regions;
    if (regions.length === 0) return;

    const cols = 10;
    const vertices: number[] = [];
    const index: number[] = [];
    for (let i = 0; i <= cols; i++) {
      const u = i / cols;
      vertices.push(u, 0, 0, u, 1, 0);
    }
    for (let i = 0; i < cols; i++) {
      const a = i * 2;
      index.push(a, a + 1, a + 3, a, a + 3, a + 2);
    }
    const base = new THREE.InstancedBufferGeometry();
    base.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    base.setIndex(index);

    const rect = new Float32Array(regions.length * 4);
    const tint = new Float32Array(regions.length * 4);
    const above = new Float32Array(regions.length);
    const curated = new Float32Array(regions.length);
    regions.forEach((region, i) => {
      rect[i * 4] = region.lon0;
      rect[i * 4 + 1] = region.lon1;
      rect[i * 4 + 2] = region.rise0;
      rect[i * 4 + 3] = region.rise1;
      const [r, g, b] = reachTint(region.reach, region.tag);
      tint[i * 4] = r;
      tint[i * 4 + 1] = g;
      tint[i * 4 + 2] = b;
      tint[i * 4 + 3] = 1;
      above[i] = region.above ? 1 : 0;
      curated[i] = region.reach === 'pinned' || region.reach === 'alias' ? 1 : 0;
    });
    base.setAttribute('iRect', new THREE.InstancedBufferAttribute(rect, 4));
    base.setAttribute('iTint', new THREE.InstancedBufferAttribute(tint, 4));
    base.setAttribute('iAbove', new THREE.InstancedBufferAttribute(above, 1));
    base.setAttribute('iCurated', new THREE.InstancedBufferAttribute(curated, 1));
    base.instanceCount = regions.length;

    const mesh = new THREE.Mesh(base, this.fillMaterial);
    mesh.frustumCulled = false;
    mesh.renderOrder = 1;
    this.fill = mesh;
    this.content.add(mesh);
  }

  /** The label pages: every tag's name fitted to the region it owns. */
  private buildLabels(wall: SeaWall): void {
    if (this.atlas === null) return;
    const atlas = this.atlas;
    const entries: LabelEntry[] = [];

    for (const region of wall.regions) {
      if (region.reflection) continue;
      const slot = atlas.slots.get(`t:${region.tag}`);
      if (slot === undefined) continue;
      const curated = region.reach === 'pinned' || region.reach === 'alias';
      entries.push({
        slot,
        lon: (region.lon0 + region.lon1) / 2,
        rise: (region.rise0 + region.rise1) / 2,
        degW: region.lon1 - region.lon0,
        degH: region.rise1 - region.rise0,
        cellW: slot.w,
        cellH: slot.h,
        tint: reachTint(region.reach, region.tag),
        alpha: curated ? 0.055 : 0.045,
      });
    }

    const grouped = new Map<number, LabelEntry[]>();
    for (const entry of entries) {
      const list = grouped.get(entry.slot.page) ?? [];
      list.push(entry);
      grouped.set(entry.slot.page, list);
    }
    for (const [page, list] of grouped) this.buildPage(page, list);
  }

  /** Create one page's mesh and fill its buffers. */
  private buildPage(page: number, entries: LabelEntry[]): void {
    if (this.atlas === null) return;
    const count = Math.min(entries.length, PAGE_INSTANCES);
    if (count === 0) return;

    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(
      new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]), 3,
    ));
    geometry.setIndex([0, 1, 2, 2, 1, 3]);
    const anchor = new Float32Array(PAGE_INSTANCES * 2);
    const uv = new Float32Array(PAGE_INSTANCES * 4);
    const tint = new Float32Array(PAGE_INSTANCES * 4);
    const deg = new Float32Array(PAGE_INSTANCES * 2);
    const cell = new Float32Array(PAGE_INSTANCES * 2);
    const attrs: THREE.InstancedBufferAttribute[] = [];
    const attr = (array: Float32Array, size: number): THREE.InstancedBufferAttribute => {
      const a = new THREE.InstancedBufferAttribute(array, size);
      a.setUsage(THREE.DynamicDrawUsage);
      attrs.push(a);
      return a;
    };
    geometry.setAttribute('iAnchor', attr(anchor, 2));
    geometry.setAttribute('iUv', attr(uv, 4));
    geometry.setAttribute('iTint', attr(tint, 4));
    geometry.setAttribute('iDeg', attr(deg, 2));
    geometry.setAttribute('iCell', attr(cell, 2));

    for (let i = 0; i < count; i++) {
      const item = entries[i];
      anchor[i * 2] = item.lon;
      anchor[i * 2 + 1] = item.rise;
      uv[i * 4] = item.slot.u0;
      uv[i * 4 + 1] = item.slot.v0;
      uv[i * 4 + 2] = item.slot.u1;
      uv[i * 4 + 3] = item.slot.v1;
      tint[i * 4] = item.tint[0];
      tint[i * 4 + 1] = item.tint[1];
      tint[i * 4 + 2] = item.tint[2];
      tint[i * 4 + 3] = item.alpha;
      deg[i * 2] = item.degW;
      deg[i * 2 + 1] = item.degH;
      cell[i * 2] = item.cellW;
      cell[i * 2 + 1] = item.cellH;
    }

    const material = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: this.atlas.textures[page] },
        uSpacing: { value: this.spacing },
        uCamLocal: { value: new THREE.Vector3() },
        uPxToWorld: { value: 0.002 },
      },
      vertexShader: LABEL_VERTEX,
      fragmentShader: LABEL_FRAGMENT,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    const mesh = new THREE.Mesh(geometry, material);
    geometry.instanceCount = count;
    mesh.frustumCulled = false;
    mesh.renderOrder = 3;
    this.content.add(mesh);
    this.pages.push({
      mesh, geometry, material, count, anchor, uv, tint, deg, cell, attrs,
    });
  }

  /** The row points: one per link, placed inside the tag's region. */
  private buildPoints(wall: SeaWall): void {
    if (this.points !== null) {
      this.content.remove(this.points);
      this.pointsGeometry?.dispose();
      this.pointsMaterial?.dispose();
      this.points = null;
    }
    const live = wall.points;
    if (live.length === 0) return;

    const count = live.length;
    const anchor = new Float32Array(count * 2);
    const size = new Float32Array(count);
    const color = new Float32Array(count * 3);
    const alpha = new Float32Array(count);
    const cell = new Float32Array(count * 2);
    const cellCount = new Float32Array(count);
    /* A point's cell and its cell's point count decide when it is a star and when it is one
       fleck of a cloud; both come from the region the point was scattered into. */
    const owners = new Map<string, WallRegion>();
    for (const region of wall.regions) {
      if (region.reflection) continue;
      owners.set(region.tag, region);
    }
    for (let i = 0; i < count; i++) {
      const point = live[i];
      anchor[i * 2] = point.lon;
      anchor[i * 2 + 1] = point.rise;
      size[i] = point.above ? 5 : 11;
      const tint = point.action === 'link' ? LINK_TINT : EDITOR_TINT;
      color[i * 3] = tint[0];
      color[i * 3 + 1] = tint[1];
      color[i * 3 + 2] = tint[2];
      alpha[i] = point.above ? 0.55 : 1;
      const owner = owners.get(point.tag);
      cell[i * 2] = owner === undefined ? 1 : owner.lon1 - owner.lon0;
      cell[i * 2 + 1] = owner === undefined ? 1 : owner.rise1 - owner.rise0;
      cellCount[i] = owner === undefined ? 1 : Math.max(1, owner.points.length);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(count * 3), 3));
    geometry.setAttribute('aAnchor', new THREE.BufferAttribute(anchor, 2));
    geometry.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    geometry.setAttribute('aColor', new THREE.BufferAttribute(color, 3));
    geometry.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1));
    geometry.setAttribute('aCell', new THREE.BufferAttribute(cell, 2));
    geometry.setAttribute('aCount', new THREE.BufferAttribute(cellCount, 1));
    geometry.setDrawRange(0, count);

    const material = new THREE.ShaderMaterial({
      uniforms: {
        uSpacing: { value: this.spacing },
        uPointer: { value: new THREE.Vector2(2, 2) },
        uDpr: { value: 1 },
        uPxToWorld: { value: 0.002 },
      },
      vertexShader: POINT_VERTEX,
      fragmentShader: POINT_FRAGMENT,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;
    points.renderOrder = 3;
    this.points = points;
    this.pointsGeometry = geometry;
    this.pointsMaterial = material;
    this.content.add(points);
  }

  /** Release the label pages and their textures. */
  private dropLabels(): void {
    for (const page of this.pages) {
      this.content.remove(page.mesh);
      page.geometry.dispose();
      page.material.dispose();
    }
    this.pages = [];
    if (this.atlas !== null) {
      for (const texture of this.atlas.textures) texture.dispose();
      this.atlas = null;
    }
  }

  /**
   * The reader's pinch, as wall spacing. It moves the tags and points; it does not resize
   * their labels.
   *
   * @param x longitude multiplier
   * @param y rise multiplier
   */
  setSpacing(x: number, y: number): void {
    const nextX = Math.min(3, Math.max(0.3, x));
    const nextY = Math.min(3, Math.max(0.3, y));
    if (nextX === this.spacing.x && nextY === this.spacing.y) return;
    this.spacing.set(nextX, nextY);
    this.markDirty();
  }

  /**
   * Pose the camera and the content.
   *
   * @param view the rig's state
   */
  setView(view: SeaViewState): void {
    this.view = view;
    this.camera.position.set(0, view.camY * UNIT, 0);
    this.camera.fov = view.fov;
    this.camera.updateProjectionMatrix();
    this.camera.rotation.set(view.pitch * RAD, Math.PI, view.roll * RAD);
    this.content.rotation.y = view.phi;
    this.content.updateMatrixWorld(true);

    this.inverse.copy(this.content.matrixWorld).invert();
    this.camLocal.copy(this.camera.position).applyMatrix4(this.inverse);
    const pxToWorld = (2 * Math.tan((view.fov * RAD) / 2)) / Math.max(1, this.height);
    for (const page of this.pages) {
      page.material.uniforms.uCamLocal.value.copy(this.camLocal);
      page.material.uniforms.uPxToWorld.value = pxToWorld;
    }
    this.starMaterial.uniforms.uCamLocal.value.copy(this.camLocal);
    this.starMaterial.uniforms.uPxToWorld.value = pxToWorld;
    const skyMaterial = this.sky.material as THREE.ShaderMaterial;
    skyMaterial.uniforms.uCamLocal.value.copy(this.camLocal);
    const ringY = view.camY * UNIT;
    skyMaterial.uniforms.uRingY.value = -ringY / Math.hypot(ringY, WALL_RADIUS);
    if (this.pointsMaterial !== null) {
      this.pointsMaterial.uniforms.uPxToWorld.value = pxToWorld;
      this.pointsMaterial.uniforms.uDpr.value = Math.min(2, window.devicePixelRatio || 1);
    }
  }

  /**
   * Highlight the tag or point under the pointer and draw its relations.
   *
   * @param hover what the pointer found, or `null`
   * @param relations the tags the table relates it to
   */
  setHover(hover: SeaHover | null, relations: readonly TagRelation[] = []): void {
    this.hover = hover;
    this.buildRelations(hover, relations);
    this.buildHighlight(hover);
    this.markDirty();
  }

  /** The hovered tag's relation arcs, drawn along the wall. */
  private buildRelations(hover: SeaHover | null, relations: readonly TagRelation[]): void {
    if (this.relations !== null) {
      this.content.remove(this.relations);
      this.relations.geometry.dispose();
      this.relations = null;
    }
    if (hover === null || this.wall === null || hover.region === undefined) return;
    const from = hover.region;
    const fromLon = (from.lon0 + from.lon1) / 2;
    const fromRise = (from.rise0 + from.rise1) / 2;
    const regionOf = (tag: string): WallRegion | undefined =>
      this.wall?.regions.find((region) => region.tag === tag);

    const positions: number[] = [];
    const colors: number[] = [];
    let drawn = 0;
    for (const relation of relations) {
      const to = regionOf(relation.tag);
      if (to === undefined || drawn >= 14) continue;
      const toLon = (to.lon0 + to.lon1) / 2;
      const toRise = (to.rise0 + to.rise1) / 2;
      let dLon = toLon - fromLon;
      if (dLon > 180) dLon -= 360;
      if (dLon < -180) dLon += 360;
      const tint = RELATION_TINT[relation.kind];
      const bow = Math.min(18, Math.abs(dLon) * 0.12 + 3);
      const steps = 16;
      for (let i = 0; i < steps; i++) {
        const t0 = i / steps;
        const t1 = (i + 1) / steps;
        positions.push(
          fromLon + dLon * t0, fromRise + (toRise - fromRise) * t0 + Math.sin(t0 * Math.PI) * bow, 0,
          fromLon + dLon * t1, fromRise + (toRise - fromRise) * t1 + Math.sin(t1 * Math.PI) * bow, 0,
        );
        colors.push(tint[0], tint[1], tint[2], tint[0], tint[1], tint[2]);
      }
      drawn++;
    }
    if (positions.length === 0) return;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('aColor', new THREE.Float32BufferAttribute(colors, 3));
    const lines = new THREE.LineSegments(geometry, this.relationMaterial);
    lines.frustumCulled = false;
    lines.renderOrder = 7;
    this.relations = lines;
    this.content.add(lines);
  }

  /** A rectangle round the hovered region, or a small ring round a hovered point. */
  private buildHighlight(hover: SeaHover | null): void {
    if (this.highlight !== null) {
      this.content.remove(this.highlight);
      this.highlight.geometry.dispose();
      this.highlight = null;
    }
    if (hover === null) return;
    const positions: number[] = [];
    const colors: number[] = [];
    const push = (lon: number, rise: number, tint: [number, number, number]): void => {
      positions.push(lon, rise, 0);
      colors.push(tint[0], tint[1], tint[2]);
    };

    if (hover.point !== undefined) {
      const point = hover.point;
      const steps = 18;
      const radius = 2.2;
      for (let i = 0; i < steps; i++) {
        const a0 = (i / steps) * Math.PI * 2;
        const a1 = ((i + 1) / steps) * Math.PI * 2;
        push(point.lon + Math.cos(a0) * radius, point.rise + Math.sin(a0) * radius, LINK_TINT);
        push(point.lon + Math.cos(a1) * radius, point.rise + Math.sin(a1) * radius, LINK_TINT);
      }
    } else if (hover.region !== undefined) {
      const region = hover.region;
      const tint = reachTint(region.reach, region.tag);
      const cols = 14;
      for (let i = 0; i < cols; i++) {
        const t0 = i / cols;
        const t1 = (i + 1) / cols;
        const lon0 = region.lon0 + (region.lon1 - region.lon0) * t0;
        const lon1 = region.lon0 + (region.lon1 - region.lon0) * t1;
        push(lon0, region.rise0, tint);
        push(lon1, region.rise0, tint);
        push(lon0, region.rise1, tint);
        push(lon1, region.rise1, tint);
      }
      push(region.lon0, region.rise0, tint);
      push(region.lon0, region.rise1, tint);
      push(region.lon1, region.rise0, tint);
      push(region.lon1, region.rise1, tint);
    }

    if (positions.length === 0) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('aColor', new THREE.Float32BufferAttribute(colors, 3));
    const line = new THREE.LineSegments(geometry, this.highlightMaterial);
    line.frustumCulled = false;
    line.renderOrder = 8;
    this.highlight = line;
    this.content.add(line);
  }

  /**
   * Find the region or point under a pointer.
   *
   * @param px pointer x, in CSS pixels from the canvas' left edge
   * @param py pointer y, in CSS pixels from the canvas' top edge
   * @returns the nearest target, or `null`
   */
  pick(px: number, py: number): SeaWallPick | null {
    if (this.wall === null) return null;
    this.camera.updateMatrixWorld();
    this.camera.matrixWorldInverse.copy(this.camera.matrixWorld).invert();
    this.content.updateMatrixWorld(true);
    this.inverse.copy(this.content.matrixWorld).invert();

    /* A star is the target: its glow is wider than its core, so the hit radius is too. */
    let bestPoint: WallPoint | undefined;
    let bestDistance = 16 * 16;
    for (const point of this.wall.points) {
      wallPoint(point.lon * this.spacing.x, point.rise * this.spacing.y, this.corner);
      this.corner.applyMatrix4(this.content.matrixWorld);
      this.cameraSpace.copy(this.corner).applyMatrix4(this.camera.matrixWorldInverse);
      if (this.cameraSpace.z > -0.05) continue;
      this.projected.copy(this.corner).project(this.camera);
      const sx = (this.projected.x * 0.5 + 0.5) * this.width;
      const sy = (-this.projected.y * 0.5 + 0.5) * this.height;
      const d = (sx - px) ** 2 + (sy - py) ** 2;
      if (d < bestDistance) {
        bestDistance = d;
        bestPoint = point;
      }
    }
    if (bestPoint !== undefined) {
      return { region: this.wall.regions.find((entry) => entry.tag === bestPoint?.tag), point: bestPoint, distance: Math.sqrt(bestDistance) };
    }

    /* Finally the wall itself. The camera stands on the axis, so the pointer is a ray
       through the centre and the wall is one intersection away. */
    this.ndc.set((px / Math.max(1, this.width)) * 2 - 1, -(py / Math.max(1, this.height)) * 2 + 1);
    this.ray.setFromCamera(this.ndc, this.camera);
    this.rayLocal.copy(this.ray.ray).applyMatrix4(this.inverse);
    const o = this.rayLocal.origin;
    const d = this.rayLocal.direction;
    const a = d.x * d.x + d.z * d.z;
    if (a < 1e-6) return null;
    const b = 2 * (o.x * d.x + o.z * d.z);
    const c = o.x * o.x + o.z * o.z - WALL_RADIUS * WALL_RADIUS;
    const disc = b * b - 4 * a * c;
    if (disc < 0) return null;
    const t = (-b + Math.sqrt(disc)) / (2 * a);
    if (!(t > 0)) return null;
    this.hit.copy(o).addScaledVector(d, t);
    const lon = wrapLon((Math.atan2(this.hit.x, this.hit.z) * DEG) / this.spacing.x);
    const rise = (this.hit.y / UNIT) / this.spacing.y;
    const region = regionOnWall(this.wall.regions, lon, rise);
    if (region === null) return null;
    return { region, distance: 0 };
  }

  /**
   * Give the dots a screen-space cursor to brighten around.
   *
   * @param x pointer x in CSS pixels, or `-1` to clear
   * @param y pointer y in CSS pixels
   */
  setPointer(x: number, y: number): void {
    if (this.pointsMaterial === null) return;
    const pointer = this.pointsMaterial.uniforms.uPointer.value as THREE.Vector2;
    const nx = x < 0 ? 2 : (x / Math.max(1, this.width)) * 2 - 1;
    const ny = x < 0 ? 2 : -(y / Math.max(1, this.height)) * 2 + 1;
    if (pointer.x === nx && pointer.y === ny) return;
    pointer.set(nx, ny);
    this.markDirty();
  }

  /**
   * Size the renderer and its passes.
   *
   * @param width CSS pixels
   * @param height CSS pixels
   */
  resize(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.setSize(this.width, this.height, false);
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
    this.composer.setSize(this.width, this.height);
    (this.post.uniforms.uRes.value as THREE.Vector2).set(this.width, this.height);
    if (this.pointsMaterial !== null) {
      this.pointsMaterial.uniforms.uDpr.value = Math.min(2, window.devicePixelRatio || 1);
    }
    this.markDirty();
  }

  /**
   * Draw one frame.
   *
   * @param dt seconds since the last frame
   * @param time seconds since the mount
   */
  render(dt: number, time: number): void {
    this.post.uniforms.uTime.value = time;
    this.relationMaterial.uniforms.uPulse.value = 0.5 + 0.5 * Math.sin(time * 2.2);
    this.composer.render(dt);
  }

  /**
   * Hand the renderer's own frame hook to the caller, or stop it with `null`.
   *
   * @param callback the frame function, or `null` to stop
   */
  setAnimationLoop(callback: (() => void) | null): void {
    this.renderer.setAnimationLoop(callback);
  }

  /** Drop the post pass's grain and most of its vignette. */
  setReduced(reduced: boolean): void {
    this.post.uniforms.uGrain.value = reduced ? 0 : 0.03;
    this.post.uniforms.uVignette.value = reduced ? 0.3 : 0.5;
    this.markDirty();
  }

  /** Release every GPU resource this scene owns. */
  dispose(): void {
    this.dropLabels();
    if (this.fill !== null) {
      this.content.remove(this.fill);
      this.fill.geometry.dispose();
    }
    if (this.points !== null) {
      this.content.remove(this.points);
      this.pointsGeometry?.dispose();
      this.pointsMaterial?.dispose();
    }
    if (this.relations !== null) {
      this.content.remove(this.relations);
      this.relations.geometry.dispose();
    }
    if (this.highlight !== null) {
      this.content.remove(this.highlight);
      this.highlight.geometry.dispose();
    }
    this.fillMaterial.dispose();
    this.relationMaterial.dispose();
    this.highlightMaterial.dispose();
    this.starMaterial.dispose();
    this.sky.geometry.dispose();
    (this.sky.material as THREE.Material).dispose();
    this.star.geometry.dispose();
    this.composer.dispose();
    this.renderer.dispose();
  }
}
