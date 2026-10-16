/**
 * seaMotion.ts — how the sea's sky glides after a flick.
 *
 * The sea is turned, not scrolled in a box: a drag moves the sky with the pointer, and
 * letting go leaves it coasting and slowing until it stops. That is the whole of the
 * model here — one offset and one speed, with the speed decaying on a clock rather than
 * per frame, so a slow machine's longer frames carry the sky as far as a fast one's short
 * frames do.
 *
 * The numbers are `SEA_MOTION`, and every one of them is overridable: `seaMotion` folds a
 * partial over the default, so a caller with its own reading of how the sky should behave
 * passes only what it disagrees with.
 *
 * Nothing here touches the DOM, so the glide is testable from numbers alone.
 */

/** How the sky behaves once it is moving. */
export interface SeaMotion {
  /** Fraction of a flick's own speed the sky keeps when the pointer lets go. */
  transfer: number;
  /** Fraction of the speed kept each second while coasting; `0.12` is a brisk stop. */
  friction: number;
  /** Coasting ends below this speed, in degrees per second. */
  minSpeed: number;
  /** Fastest the sky may coast, in degrees per second — a flick cannot outrun a hand. */
  maxSpeed: number;
  /** Degrees per second each 100 units of a wheel notch adds. */
  wheelGain: number;
}

/**
 * The shipped behaviour, in the units the coast is read in.
 *
 * A coast from speed `v` travels `v / ln(1 / friction)` degrees before it settles, so a
 * wheel notch here is `60 / 2.12` — a quarter of the field of view the sea opens on — and
 * a hard flick is a little over half of it. Both numbers are what "smooth" has to mean on
 * a backdrop: visible movement, and a stop.
 */
export const SEA_MOTION: SeaMotion = {
  transfer: 0.9,
  friction: 0.12,
  minSpeed: 3,
  maxSpeed: 360,
  wheelGain: 60,
};

/**
 * The shipped motion, with a caller's own values folded over it.
 *
 * @param over the fields to change
 * @returns the motion to use
 */
export function seaMotion(over: Partial<SeaMotion> = {}): SeaMotion {
  return { ...SEA_MOTION, ...over };
}

/** Where the sky sits and how fast it is still moving, in degrees and degrees per second. */
export interface Glide {
  /** How far the sky has scrolled from its resting place. */
  offset: number;
  /** How fast it is still moving; exactly `0` once it has settled. */
  speed: number;
}

/**
 * The speed a pointer was moving at, from how far it went and how long it took.
 *
 * @param degrees how far the sky moved
 * @param ms how long the movement took
 * @returns degrees per second, `0` when no time passed
 */
export function flickSpeed(degrees: number, ms: number): number {
  return ms <= 0 ? 0 : degrees / (ms / 1000);
}

/**
 * What a flick leaves behind: the offset it reached, and the speed the sky coasts at.
 *
 * @param offset where the drag ended
 * @param speed the pointer's own speed, as {@link flickSpeed} measured it
 * @param motion the motion to use
 * @returns the glide to start from; already at rest when the flick was too gentle
 */
export function glideRelease(offset: number, speed: number, motion: SeaMotion = SEA_MOTION): Glide {
  const wanted = speed * motion.transfer;
  const capped = Math.max(-motion.maxSpeed, Math.min(motion.maxSpeed, wanted));
  return capped === 0 || Math.abs(capped) < motion.minSpeed ? { offset, speed: 0 } : { offset, speed: capped };
}

/**
 * One frame of coasting.
 *
 * The speed is decayed by the elapsed time rather than once per frame, and the offset is
 * carried at the frame's average speed, so a coast covers the same ground whatever the
 * frame rate it was drawn at.
 *
 * @param glide where the sky is now
 * @param ms milliseconds since the last frame
 * @param motion the motion to use
 * @returns the next glide, settled once the speed falls under `minSpeed`
 */
export function glideStep(glide: Glide, ms: number, motion: SeaMotion = SEA_MOTION): Glide {
  if (glide.speed === 0 || ms <= 0) return glide;
  const seconds = ms / 1000;
  const next = glide.speed * motion.friction ** seconds;
  const offset = glide.offset + ((glide.speed + next) / 2) * seconds;
  return Math.abs(next) < motion.minSpeed ? { offset, speed: 0 } : { offset, speed: next };
}

/**
 * The glide a wheel notch starts.
 *
 * @param offset where the sky is now
 * @param deltaY the wheel's own delta
 * @param motion the motion to use
 * @returns the glide to coast with
 */
export function glideWheel(offset: number, deltaY: number, motion: SeaMotion = SEA_MOTION): Glide {
  return glideRelease(offset, (deltaY / 100) * motion.wheelGain, { ...motion, transfer: 1 });
}

/**
 * Whether the sky has stopped moving.
 *
 * @param glide where the sky is now
 * @returns true once there is no speed left to spend
 */
export function glideAtRest(glide: Glide): boolean {
  return glide.speed === 0;
}

/** The tree key a stored momentum strength is read from, 0 to 100. */
export const SEA_MOMENTUM_KEY = 'seaMomentum';

/**
 * The motion a stored strength asks for.
 *
 * At `0` the sky stops the instant the pointer lets go; at `100` a flick carries for
 * seconds. Anything absent, out of range or unreadable leaves the shipped values standing,
 * so a table that has never been told otherwise behaves as {@link SEA_MOTION} says.
 *
 * @param stored the value read from the settings tree
 * @returns the motion to use
 */
export function seaMotionFrom(stored: unknown): SeaMotion {
  if (stored === null || stored === undefined || stored === '') return SEA_MOTION;
  const strength = Number(stored);
  if (!Number.isFinite(strength)) return SEA_MOTION;
  const t = Math.min(1, Math.max(0, strength / 100));
  /* Both halves move with the strength: a flick keeps all of its own speed at the top and
     none at the bottom, and the coast decays slowly at the top and sharply at the bottom. */
  return seaMotion({ transfer: t, friction: 0.02 + 0.48 * (1 - t) });
}
