/**
 * seaFeel.ts — the camera rig the sea is read through.
 *
 * The world never moves its camera on the input frame: the scroll target and the yaw target
 * are moved by input, and a spring-damped body follows them. The lag is the weight. A release
 * hands the velocity to the target, which then coasts on a clock rather than per frame, so a
 * flick carries the same distance at 30 and 120 fps.
 *
 * The four degrees of freedom are the whole of the interaction: scroll (body height), yaw
 * (turning on the spot), pitch (five detents) and zoom (an eased field of view). Sea level
 * leans the aim on its own as well: up above the horizon, down below it, so a dive reads as
 * a dive with the surface overhead. Nothing here touches the DOM or three.js, so the feel is
 * testable from numbers alone.
 */

/** Frame-rate-independent approach: the gap closes by `1 - exp(-dt / tau)` each frame. */
export function damp(from: number, to: number, tau: number, dt: number): number {
  if (!(dt > 0)) return from;
  if (!(tau > 0)) return to;
  return to + (from - to) * Math.exp(-dt / tau);
}

/** A value and its velocity, as the spring below carries them. */
export interface Spring {
  x: number;
  v: number;
}

/** Longest step the spring integrates in one go, so a stalled tab cannot explode it. */
const MAX_STEP = 1 / 120;

/** Longest a single frame may advance the rig, so a background tab does not teleport it. */
const MAX_FRAME = 0.1;

/**
 * One step of a damped spring, integrated semi-implicitly and substepped.
 *
 * @param state the value and velocity, mutated in place
 * @param target where the spring is headed
 * @param omega angular frequency, radians per second
 * @param zeta damping ratio; below 1 overshoots
 * @param dt elapsed seconds
 */
export function springStep(
  state: Spring, target: number, omega: number, zeta: number, dt: number,
): void {
  let left = Math.min(Math.max(0, dt), MAX_FRAME);
  while (left > 0) {
    const h = Math.min(MAX_STEP, left);
    const accel = -2 * zeta * omega * state.v - omega * omega * (state.x - target);
    state.v += accel * h;
    state.x += state.v * h;
    left -= h;
  }
}

/** The numbers the feel is built from. */
export const SEA_FEEL = {
  /** Field of view, degrees: open view, deliberate zoom range, sprint kick. */
  fovBase: 48,
  fovMin: 38,
  fovMax: 60,
  fovSprint: 5,
  fovLock: -4,
  fovTau: 0.2,
  fovPerWheel: 0.02,
  /** The body that carries the camera height. */
  springOmega: 7,
  springZeta: 0.92,
  /** Scroll speed, acceleration and coast. */
  scrollMax: 26,
  scrollSprint: 44,
  scrollAccel: 70,
  scrollFriction: 0.45,
  /** Yaw speed, acceleration and coast, degrees. */
  yawMax: 100,
  yawAccel: 420,
  yawFriction: 0.35,
  yawSpringOmega: 10,
  yawSpringZeta: 0.9,
  /** Roll into a turn, and lean into a scroll. */
  rollGain: 0.05,
  rollMax: 3,
  rollTau: 0.3,
  leanGain: 0.15,
  leanMax: 4,
  /** How far sea level tilts the aim, degrees: up above the horizon, down below it. */
  levelPitch: 6,
  /** Fog, and the band over which sea level changes it. */
  fogDensity: 0.025,
  levelBelow: 1.15,
  levelAbove: 0.85,
  levelSpan: 15,
  /** Zoom a pointer drag asks for, degrees per wheel pixel the pinch measured. */
  pinchPerPixel: 0.12,
} as const;

/** The pitch detents, in degrees. Positive looks up. */
export const PITCH_NOTCHES = [-24, -12, 0, 12, 24] as const;

/** Milliseconds a notch takes to settle. */
export const PITCH_MS = 250;

/**
 * The smooth step that keeps a notch mechanical at both ends.
 *
 * @param t progress in `[0, 1]`
 * @returns eased progress
 */
export function easeInOutCubic(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return c < 0.5 ? 4 * c * c * c : 1 - ((-2 * c + 2) ** 3) / 2;
}

/**
 * The pitch between two detents.
 *
 * @param from the detent the notch started at
 * @param to the detent it is headed for
 * @param t progress in `[0, 1]`
 * @returns degrees
 */
export function notchPitch(from: number, to: number, t: number): number {
  return from + (to - from) * easeInOutCubic(t);
}

/**
 * The next detent, clamped at the ends so a notch cannot walk past the range.
 *
 * @param index the detent now
 * @param delta detents to move, positive up
 * @returns the next index
 */
export function notchIndex(index: number, delta: number): number {
  return Math.min(PITCH_NOTCHES.length - 1, Math.max(0, index + delta));
}

/**
 * How far above sea level a height reads, in `[0, 1]`.
 *
 * @param y camera height
 * @returns 0 well below the horizon, 1 well above it
 */
export function seaLevel(y: number): number {
  const t = Math.min(1, Math.max(0, (y + SEA_FEEL.levelSpan) / (2 * SEA_FEEL.levelSpan)));
  return t * t * (3 - 2 * t);
}

/**
 * The pitch sea level asks for on its own: up above the horizon, down below it, so the star
 * and its ring stay overhead once the camera dives and the wall below reads as the deep.
 *
 * @param y camera height
 * @returns degrees, positive up
 */
export function levelPitch(y: number): number {
  return SEA_FEEL.levelPitch * (2 * seaLevel(y) - 1);
}

/**
 * Fog density at a height: thinner above the horizon, denser below it.
 *
 * @param y camera height
 * @returns the FogExp2 density
 */
export function fogDensity(y: number): number {
  const level = seaLevel(y);
  return SEA_FEEL.fogDensity
    * (SEA_FEEL.levelBelow + (SEA_FEEL.levelAbove - SEA_FEEL.levelBelow) * level);
}

/** Everything one frame of the rig carries. */
export interface SeaRig {
  /** The body's height and the target it springs toward. */
  camY: number;
  scrollTarget: number;
  vScroll: number;
  /** The content's rotation in radians, its target, and their velocities. */
  phi: number;
  yawTarget: number;
  vYaw: number;
  phiV: number;
  camV: number;
  /** Pitch detents, degrees: current, current target, and the notch's progress. */
  pitch: number;
  pitchIndex: number;
  pitchFrom: number;
  pitchTo: number;
  pitchT: number;
  /** Camera roll in degrees, rolled into a turn. */
  roll: number;
  /** Field of view, degrees. */
  fov: number;
  fovBase: number;
  /** Eased height reading, `0` below sea level and `1` above. */
  level: number;
}

/** A rig at rest, facing the table's first meridian with a level, open view. */
export function createRig(): SeaRig {
  return {
    camY: 0, scrollTarget: 0, vScroll: 0,
    phi: 0, yawTarget: 0, vYaw: 0, phiV: 0, camV: 0,
    pitch: 0, pitchIndex: 2, pitchFrom: 0, pitchTo: 0, pitchT: 1,
    roll: 0, fov: SEA_FEEL.fovBase, fovBase: SEA_FEEL.fovBase, level: 0.5,
  };
}

/** The pose the renderer draws, in the units its own view state takes. */
export interface SeaPose {
  /** Rise the camera is level with, in degrees. */
  camY: number;
  /** Content rotation, in radians. */
  phi: number;
  /** Camera pitch, in degrees. */
  pitch: number;
  /** Camera roll, in degrees. */
  roll: number;
  /** Vertical field of view, in degrees. */
  fov: number;
}

/** Per-frame pose changes smaller than these move the image by less than a pixel. */
export const SEA_IDLE = {
  camY: 0.004, phi: 1e-4, pitch: 0.001, roll: 0.001, fov: 0.001,
} as const;

/**
 * Whether two poses differ too little for a new frame to change the image.
 *
 * The springs converge exponentially, so without this test they would keep the sea drawing
 * forever; the bounds are a fraction of the smallest screen distance one pose unit covers.
 *
 * @param prev the pose of the last drawn frame
 * @param next the pose this frame would draw
 * @returns true when the frame can be skipped
 */
export function poseSettled(prev: SeaPose, next: SeaPose): boolean {
  return Math.abs(next.camY - prev.camY) <= SEA_IDLE.camY
    && Math.abs(next.phi - prev.phi) <= SEA_IDLE.phi
    && Math.abs(next.pitch - prev.pitch) <= SEA_IDLE.pitch
    && Math.abs(next.roll - prev.roll) <= SEA_IDLE.roll
    && Math.abs(next.fov - prev.fov) <= SEA_IDLE.fov;
}

/** What one frame is told about the world around the rig. */
export interface RigStep {
  /** Seconds since the last frame. */
  dt: number;
  /** Shift is held: the scroll runs at its sprint speed. */
  sprint: boolean;
  /** A drag owns the targets this frame, so the coast must not also carry them. */
  hold: boolean;
  /** The tag the reader locked on to, in wall coordinates; absent when nothing is locked. */
  locked: { y: number; yaw: number } | null;
  /** The reader asked for less motion: no roll, no lean, half the sprint kick. */
  reduced: boolean;
  /** Momentum strength in `[0, 1]`; absent reads the shipped middle. */
  momentum?: number;
}

/**
 * Advance the rig one frame.
 *
 * Input has already moved `scrollTarget` and `yawTarget` by the time this runs; what this adds
 * is the coast, the locks, and the springs that make the camera lag its target.
 *
 * @param rig the rig, mutated in place
 * @param step what the frame knows
 */
export function stepRig(rig: SeaRig, step: RigStep): void {
  const dt = Math.min(MAX_FRAME, Math.max(0, step.dt));
  if (dt === 0) return;

  if (step.locked !== null) {
    rig.yawTarget = damp(rig.yawTarget, step.locked.yaw, 0.8, dt);
    rig.scrollTarget = damp(rig.scrollTarget, step.locked.y, 1.0, dt);
  }

  if (!step.hold) {
    const max = step.sprint ? SEA_FEEL.scrollSprint : SEA_FEEL.scrollMax;
    const momentum = Math.min(1, Math.max(0, step.momentum ?? 0.5));
    const scrollTau = SEA_FEEL.scrollFriction * (0.2 + 1.6 * momentum);
    const yawTau = SEA_FEEL.yawFriction * (0.25 + 1.5 * momentum);
    const yawMax = (SEA_FEEL.yawMax * Math.PI) / 180;
    rig.vScroll = Math.min(max, Math.max(-max, rig.vScroll));
    rig.scrollTarget += rig.vScroll * dt;
    rig.vScroll *= Math.exp(-dt / scrollTau);
    if (Math.abs(rig.vScroll) < 0.04) rig.vScroll = 0;

    rig.vYaw = Math.min(yawMax, Math.max(-yawMax, rig.vYaw));
    rig.yawTarget += rig.vYaw * dt;
    rig.vYaw *= Math.exp(-dt / yawTau);
    if (Math.abs(rig.vYaw) < 0.0005) rig.vYaw = 0;
  }

  const height: Spring = { x: rig.camY, v: rig.camV };
  springStep(height, rig.scrollTarget, SEA_FEEL.springOmega, SEA_FEEL.springZeta, dt);
  rig.camY = height.x;
  rig.camV = height.v;

  const turn: Spring = { x: rig.phi, v: rig.phiV };
  springStep(turn, rig.yawTarget, SEA_FEEL.yawSpringOmega, SEA_FEEL.yawSpringZeta, dt);
  rig.phi = turn.x;
  rig.phiV = turn.v;

  rig.pitchT = Math.min(1, rig.pitchT + (dt * 1000) / PITCH_MS);
  rig.pitch = notchPitch(rig.pitchFrom, rig.pitchTo, rig.pitchT);

  const yawDeg = (rig.vYaw * 180) / Math.PI;
  const wantedRoll = step.reduced
    ? 0
    : clamp(-yawDeg * SEA_FEEL.rollGain, SEA_FEEL.rollMax);
  rig.roll = damp(rig.roll, wantedRoll, SEA_FEEL.rollTau, dt);

  const kick = (step.sprint ? SEA_FEEL.fovSprint : 0) / (step.reduced ? 2 : 1);
  const fovTarget = limit(
    rig.fovBase + kick + (step.locked === null ? 0 : SEA_FEEL.fovLock),
    SEA_FEEL.fovMin, SEA_FEEL.fovMax,
  );
  rig.fov = damp(rig.fov, fovTarget, SEA_FEEL.fovTau, dt);

  rig.level = damp(rig.level, seaLevel(rig.camY), 0.5, dt);
}

/**
 * A number folded into `[-max, max]`.
 *
 * @param n the number
 * @param max the positive bound
 * @returns the folded number
 */
function clamp(n: number, max: number): number {
  return Math.min(max, Math.max(-max, n));
}

/**
 * A number folded into `[lo, hi]`.
 *
 * @param n the number
 * @param lo the lower bound
 * @param hi the upper bound
 * @returns the folded number
 */
function limit(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * One wheel notch of scroll: it adds velocity to the body, which coasts to rest.
 *
 * @param rig the rig, mutated in place
 * @param deltaY the wheel's own delta, positive down
 */
export function wheelScroll(rig: SeaRig, deltaY: number): void {
  rig.vScroll = clamp(rig.vScroll - deltaY * 0.15, SEA_FEEL.scrollMax);
}

/**
 * One wheel notch of zoom, Ctrl or ⌘ held.
 *
 * @param rig the rig, mutated in place
 * @param deltaY the wheel's own delta, positive out
 */
export function wheelZoom(rig: SeaRig, deltaY: number): void {
  rig.fovBase = Math.min(SEA_FEEL.fovMax,
    Math.max(SEA_FEEL.fovMin, rig.fovBase + deltaY * SEA_FEEL.fovPerWheel));
}

/**
 * Step the pitch to the next detent.
 *
 * @param rig the rig, mutated in place
 * @param delta detents to move, positive up
 */
export function notch(rig: SeaRig, delta: number): void {
  const next = notchIndex(rig.pitchIndex, delta);
  if (next === rig.pitchIndex) return;
  rig.pitchIndex = next;
  rig.pitchFrom = rig.pitch;
  rig.pitchTo = PITCH_NOTCHES[next];
  rig.pitchT = 0;
}

/**
 * The pitch the camera is actually aimed at: the detent plus the lean a scroll adds.
 *
 * @param rig the rig
 * @param reduced whether the reader asked for less motion
 * @returns degrees
 */
export function leanedPitch(rig: SeaRig, reduced: boolean): number {
  if (reduced) return rig.pitch;
  return rig.pitch + clamp(rig.vScroll * SEA_FEEL.leanGain, SEA_FEEL.leanMax);
}
