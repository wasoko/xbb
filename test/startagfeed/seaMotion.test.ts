/**
 * seaMotion.test.ts — how the sea's sky glides after a flick.
 *
 * The model is one offset and one speed, so the tests check the four things that decide
 * how a scroll feels: what a flick hands over, how the coast decays, that the decay is on
 * the clock rather than per frame, and that it settles instead of creeping forever.
 */

import { describe, expect, it } from 'vitest';
import {
  SEA_MOTION, SEA_MOMENTUM_KEY, flickSpeed, glideAtRest, glideRelease, glideStep,
  glideWheel, seaMotion, seaMotionFrom,
} from '../../src/ui/seaMotion';

const M = seaMotion();

describe('seaMotion', () => {
  it('shipped values stand, and a caller changes only what it disagrees with', () => {
    expect(seaMotion()).toEqual(SEA_MOTION);
    expect(seaMotion({ friction: 0.5 })).toEqual({ ...SEA_MOTION, friction: 0.5 });
    expect(SEA_MOTION.friction).toBe(0.12);
  });
});

describe('flickSpeed', () => {
  it('reads a drag as degrees per second', () => {
    expect(flickSpeed(30, 100)).toBeCloseTo(300, 9);
    expect(flickSpeed(-45, 500)).toBeCloseTo(-90, 9);
  });

  it('is nothing when no time passed, rather than infinite', () => {
    expect(flickSpeed(30, 0)).toBe(0);
    expect(flickSpeed(30, -5)).toBe(0);
  });
});

describe('glideRelease', () => {
  it('hands over the flick minus what the transfer keeps back', () => {
    const g = glideRelease(12, 400, M);
    expect(g.offset).toBe(12);
    expect(g.speed).toBeCloseTo(400 * M.transfer, 9);
  });

  it('caps a violent flick', () => {
    expect(glideRelease(0, 100000, M).speed).toBe(M.maxSpeed);
    expect(glideRelease(0, -100000, M).speed).toBe(-M.maxSpeed);
  });

  it('settles a flick too gentle to be worth coasting', () => {
    expect(glideRelease(5, M.minSpeed / M.transfer - 1, M)).toEqual({ offset: 5, speed: 0 });
    expect(glideRelease(5, 0, M)).toEqual({ offset: 5, speed: 0 });
  });

  it('stops dead when the reader asked for no momentum', () => {
    const still = seaMotionFrom(0);
    expect(glideRelease(9, 900, still)).toEqual({ offset: 9, speed: 0 });
  });
});

describe('glideStep', () => {
  it('carries the sky and slows it, both monotonically', () => {
    let g = glideRelease(0, 600, M);
    let previous = Math.abs(g.speed);
    for (let i = 0; i < 5; i++) {
      g = glideStep(g, 16, M);
      expect(Math.abs(g.speed)).toBeLessThan(previous);
      expect(g.offset).toBeGreaterThan(0);
      previous = Math.abs(g.speed);
    }
  });

  it('covers the same ground at any frame rate', () => {
    const coarse = glideStep({ offset: 0, speed: 600 }, 100, M);
    let fine = { offset: 0, speed: 600 };
    for (let i = 0; i < 10; i++) fine = glideStep(fine, 10, M);
    expect(Math.abs(fine.offset - coarse.offset) / coarse.offset).toBeLessThan(0.01);
    expect(Math.abs(fine.speed - coarse.speed) / coarse.speed).toBeLessThan(0.01);
  });

  it('settles instead of creeping, and stops carrying once it has', () => {
    let g: { offset: number; speed: number } = glideRelease(0, 600, M);
    let frames = 0;
    while (!glideAtRest(g) && frames < 100000) {
      g = glideStep(g, 16, M);
      frames++;
    }
    expect(glideAtRest(g)).toBe(true);
    expect(g.speed).toBe(0);
    /* A brisk friction settles inside a few seconds, not a few minutes. */
    expect(frames * 16).toBeLessThan(6000);
    const settled = g.offset;
    expect(glideStep(g, 16, M).offset).toBe(settled);
  });

  it('is unchanged by a frame that took no time, or by one already at rest', () => {
    const moving = { offset: 3, speed: 100 };
    expect(glideStep(moving, 0, M)).toEqual(moving);
    expect(glideStep(moving, -4, M)).toEqual(moving);
    const still = { offset: 3, speed: 0 };
    expect(glideStep(still, 16, M)).toEqual(still);
  });

  it('coasts backwards when the flick was upwards', () => {
    const g = glideStep(glideRelease(0, -600, M), 100, M);
    expect(g.offset).toBeLessThan(0);
    expect(g.speed).toBeLessThan(0);
  });
});

describe('glideWheel', () => {
  it('turns a notch into a coast', () => {
    const g = glideWheel(0, 100, M);
    expect(g.speed).toBeCloseTo(M.wheelGain, 9);
    expect(g.speed).toBeLessThanOrEqual(M.maxSpeed);
  });

  it('scales with how far the wheel turned, and reverses with it', () => {
    expect(glideWheel(0, 100, M).speed).toBeCloseTo(2 * glideWheel(0, 50, M).speed, 9);
    expect(glideWheel(0, -100, M).speed).toBeLessThan(0);
  });

  it('caps a wheel spun far past what a hand can flick', () => {
    expect(glideWheel(0, 100000, M).speed).toBe(M.maxSpeed);
    expect(glideWheel(0, -100000, M).speed).toBe(-M.maxSpeed);
  });

  it('keeps the whole notch, unlike a flick', () => {
    /* A wheel has no pointer to let go of, so there is nothing for the transfer to hold back. */
    expect(glideWheel(0, 100, M).speed).toBeGreaterThan(glideRelease(0, M.wheelGain, M).speed);
  });

  it('leaves the offset it was given alone', () => {
    expect(glideWheel(42, 100, M).offset).toBe(42);
  });
});

describe('seaMotionFrom', () => {
  it('falls back to the shipped values for anything it cannot read', () => {
    expect(seaMotionFrom(undefined)).toEqual(SEA_MOTION);
    expect(seaMotionFrom(null)).toEqual(SEA_MOTION);
    expect(seaMotionFrom('')).toEqual(SEA_MOTION);
    expect(seaMotionFrom('brisk')).toEqual(SEA_MOTION);
    expect(seaMotionFrom(Number.NaN)).toEqual(SEA_MOTION);
  });

  it('spans no momentum to all of it, and clamps what is past either end', () => {
    expect(seaMotionFrom(0).transfer).toBe(0);
    expect(seaMotionFrom(100).transfer).toBe(1);
    expect(seaMotionFrom(-40).transfer).toBe(0);
    expect(seaMotionFrom(400).transfer).toBe(1);
  });

  it('decays more slowly the more momentum is asked for', () => {
    expect(seaMotionFrom(100).friction).toBeLessThan(seaMotionFrom(50).friction);
    expect(seaMotionFrom(50).friction).toBeLessThan(seaMotionFrom(0).friction);
  });

  it('reads a value stored as a string, which is how the settings tree holds one', () => {
    expect(seaMotionFrom('100')).toEqual(seaMotionFrom(100));
    expect(SEA_MOMENTUM_KEY).toBe('seaMomentum');
  });
});
