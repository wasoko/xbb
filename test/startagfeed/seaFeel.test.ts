/**
 * seaFeel.test.ts — the camera rig's feel, from numbers alone.
 *
 * The rig is the whole interaction, so the tests pin the properties a later tuning must keep:
 * damping that does not depend on frame rate, a spring that settles without ringing forever,
 * a notch that ends exactly on its detent, and a coast that carries and then stops.
 */

import { describe, expect, it } from 'vitest';
import {
  PITCH_NOTCHES, SEA_FEEL, SEA_IDLE, createRig, damp, fogDensity, leanedPitch, notch, notchIndex,
  notchPitch, poseSettled, seaLevel, springStep, stepRig, wheelScroll, wheelZoom,
} from '../../src/ui/seaFeel';

describe('damp', () => {
  it('closes the same fraction of the gap in the same elapsed time', () => {
    const one = damp(0, 10, 0.4, 0.1);
    let fine = 0;
    for (let i = 0; i < 10; i++) fine = damp(fine, 10, 0.4, 0.01);
    expect(fine).toBeCloseTo(one, 9);
  });

  it('does not move without time, and lands on the target at zero tau', () => {
    expect(damp(3, 9, 0.5, 0)).toBe(3);
    expect(damp(3, 9, 0, 0.1)).toBe(9);
  });
});

describe('springStep', () => {
  it('settles on the target', () => {
    const state = { x: 0, v: 0 };
    for (let i = 0; i < 400; i++) springStep(state, 12, SEA_FEEL.springOmega, SEA_FEEL.springZeta, 1 / 60);
    expect(state.x).toBeCloseTo(12, 2);
    expect(Math.abs(state.v)).toBeLessThan(0.05);
  });

  it('overshoots a little and comes back, which is where the weight reads', () => {
    const state = { x: 0, v: 0 };
    let peak = 0;
    for (let i = 0; i < 120; i++) {
      springStep(state, 10, SEA_FEEL.springOmega, SEA_FEEL.springZeta, 1 / 60);
      peak = Math.max(peak, state.x);
    }
    expect(peak).toBeGreaterThan(10);
    expect(peak).toBeLessThan(10.6);
    expect(state.x).toBeCloseTo(10, 1);
  });

  it('reads the same distance at any frame rate', () => {
    const coarse = { x: 0, v: 0 };
    const fine = { x: 0, v: 0 };
    for (let i = 0; i < 10; i++) springStep(coarse, 10, 7, 0.92, 1 / 60);
    for (let i = 0; i < 20; i++) springStep(fine, 10, 7, 0.92, 1 / 120);
    expect(fine.x).toBeCloseTo(coarse.x, 6);
  });
});

describe('pitch notches', () => {
  it('lands exactly on a detent and stays inside the range', () => {
    expect(notchIndex(2, 1)).toBe(3);
    expect(notchIndex(4, 1)).toBe(4);
    expect(notchIndex(0, -1)).toBe(0);
    expect(notchPitch(-12, 12, 1)).toBe(PITCH_NOTCHES[3]);
  });

  it('is settled at both ends of the step', () => {
    expect(notchPitch(-24, 12, 0)).toBe(-24);
    expect(notchPitch(-24, 12, 0.5)).toBeCloseTo(-6, 9);
    expect(notchPitch(-24, 12, 1)).toBe(12);
  });

  it('steps the rig between detents and eases the whole way', () => {
    const rig = createRig();
    notch(rig, 1);
    stepRig(rig, { dt: 1 / 60, sprint: false, hold: true, locked: null, reduced: false });
    const early = rig.pitch;
    expect(early).toBeGreaterThan(0);
    expect(early).toBeLessThan(PITCH_NOTCHES[3]);
    for (let i = 0; i < 60; i++) {
      stepRig(rig, { dt: 1 / 60, sprint: false, hold: true, locked: null, reduced: false });
    }
    expect(rig.pitch).toBe(PITCH_NOTCHES[3]);
  });
});

describe('sea level', () => {
  it('reads 0 below, 1 above, and half at the horizon', () => {
    expect(seaLevel(-100)).toBe(0);
    expect(seaLevel(0)).toBeCloseTo(0.5, 9);
    expect(seaLevel(100)).toBe(1);
  });

  it('thins the fog above the horizon and thickens it below', () => {
    expect(fogDensity(100)).toBeLessThan(fogDensity(0));
    expect(fogDensity(-100)).toBeGreaterThan(fogDensity(0));
  });
});

describe('scroll and yaw', () => {
  it('a wheel notch moves the body and then stops', () => {
    const rig = createRig();
    wheelScroll(rig, 100);
    for (let i = 0; i < 200; i++) {
      stepRig(rig, { dt: 1 / 60, sprint: false, hold: false, locked: null, reduced: false });
    }
    expect(rig.camY).not.toBe(0);
    expect(rig.vScroll).toBe(0);
    expect(Math.abs(rig.camY)).toBeGreaterThan(1);
  });

  it('keeps the feel at the top of the momentum range', () => {
    const brisk = createRig();
    const gliding = createRig();
    wheelScroll(brisk, 100);
    wheelScroll(gliding, 100);
    for (let i = 0; i < 30; i++) {
      stepRig(brisk, {
        dt: 1 / 60, sprint: false, hold: false, locked: null, reduced: false, momentum: 0,
      });
      stepRig(gliding, {
        dt: 1 / 60, sprint: false, hold: false, locked: null, reduced: false, momentum: 1,
      });
    }
    expect(Math.abs(gliding.camY)).toBeGreaterThan(Math.abs(brisk.camY));
  });

  it('zooms only inside its own range', () => {
    const rig = createRig();
    for (let i = 0; i < 100; i++) wheelZoom(rig, -1000);
    expect(rig.fovBase).toBe(SEA_FEEL.fovMin);
    for (let i = 0; i < 100; i++) wheelZoom(rig, 1000);
    expect(rig.fovBase).toBe(SEA_FEEL.fovMax);
  });

  it('drops the lean and the roll when the reader asked for less motion', () => {
    const rig = createRig();
    wheelScroll(rig, 100);
    rig.vYaw = 1;
    for (let i = 0; i < 30; i++) {
      stepRig(rig, { dt: 1 / 60, sprint: false, hold: false, locked: null, reduced: true });
    }
    expect(rig.roll).toBe(0);
    expect(leanedPitch(rig, true)).toBe(rig.pitch);
  });
});

describe('pose settle', () => {
  const pose = { camY: 12, phi: 0.4, pitch: -12, roll: 2, fov: 48 };

  it('accepts an unchanged pose', () => {
    expect(poseSettled(pose, { ...pose })).toBe(true);
  });

  it('accepts a change below the pixel bound on every axis', () => {
    expect(poseSettled(pose, {
      camY: pose.camY + SEA_IDLE.camY,
      phi: pose.phi + SEA_IDLE.phi,
      pitch: pose.pitch + SEA_IDLE.pitch,
      roll: pose.roll + SEA_IDLE.roll,
      fov: pose.fov + SEA_IDLE.fov,
    })).toBe(true);
  });

  it('refuses a change above the pixel bound on any axis', () => {
    expect(poseSettled(pose, { ...pose, camY: pose.camY + SEA_IDLE.camY * 2 })).toBe(false);
    expect(poseSettled(pose, { ...pose, phi: pose.phi + SEA_IDLE.phi * 2 })).toBe(false);
    expect(poseSettled(pose, { ...pose, pitch: pose.pitch + SEA_IDLE.pitch * 2 })).toBe(false);
    expect(poseSettled(pose, { ...pose, roll: pose.roll + SEA_IDLE.roll * 2 })).toBe(false);
    expect(poseSettled(pose, { ...pose, fov: pose.fov + SEA_IDLE.fov * 2 })).toBe(false);
  });
});
