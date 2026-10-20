/**
 * perfWatch.test.ts — the thresholds the hourly sample is judged by.
 *
 * The runtime delivery is `stts`'s own concern; these tests pin the arithmetic that decides
 * whether a window is a warning, including the windows too short or too idle to judge.
 */

import { describe, expect, it } from 'vitest';
import { PERF_WATCH, perfIssues, type PerfSample } from '../src/perfWatch';

/** A five-minute window with every reading inside its threshold. */
const healthy = (over: Partial<PerfSample> = {}): PerfSample => ({
  windowMs: 5 * 60_000,
  blockingMs: 0,
  longTasks: 0,
  frames: 1_000,
  slowFrames: 0,
  idleFrames: 0,
  ...over,
});

describe('perfIssues', () => {
  it('reports nothing for a healthy window', () => {
    expect(perfIssues(healthy())).toEqual([]);
  });

  it('does not judge a window shorter than the minimum', () => {
    const short = healthy({ windowMs: 30_000, blockingMs: 15_000 });
    expect(perfIssues(short)).toEqual([]);
  });

  it('reports CPU when long tasks hold the main thread', () => {
    const sample = healthy({
      blockingMs: PERF_WATCH.cpuBlockedShare * 5 * 60_000 + 1,
      longTasks: 12,
    });
    expect(perfIssues(sample).map((issue) => issue.signal)).toEqual(['cpu']);
  });

  it('reports memory when the heap is near its ceiling', () => {
    const limit = 4 * 1024 ** 3;
    const sample = healthy({ heapUsed: limit * PERF_WATCH.memoryUsedShare + 1, heapLimit: limit });
    expect(perfIssues(sample).map((issue) => issue.signal)).toEqual(['memory']);
  });

  it('does not judge the heap without a limit', () => {
    expect(perfIssues(healthy({ heapUsed: 3 * 1024 ** 3 }))).toEqual([]);
  });

  it('reports GPU when too many drawn frames are slow', () => {
    const sample = healthy({
      frames: 1_000,
      slowFrames: PERF_WATCH.slowFrameShare * 1_000 + 1,
    });
    expect(perfIssues(sample).map((issue) => issue.signal)).toEqual(['gpu']);
  });

  it('does not judge slow frames below the minimum frame count', () => {
    const sample = healthy({ frames: 100, slowFrames: 100 });
    expect(perfIssues(sample)).toEqual([]);
  });

  it('reports GPU when the sea draws with a settled pose', () => {
    const seconds = 5 * 60;
    const sample = healthy({ idleFrames: (PERF_WATCH.idleDrawsPerSec + 10) * seconds });
    expect(perfIssues(sample).map((issue) => issue.signal)).toEqual(['gpu']);
  });

  it('reports every crossed signal in one result', () => {
    const limit = 4 * 1024 ** 3;
    const seconds = 5 * 60;
    const sample = healthy({
      blockingMs: PERF_WATCH.cpuBlockedShare * seconds * 1_000 + 1,
      heapUsed: limit * PERF_WATCH.memoryUsedShare + 1,
      heapLimit: limit,
      slowFrames: 900,
      idleFrames: (PERF_WATCH.idleDrawsPerSec + 10) * seconds,
    });
    expect(perfIssues(sample).map((issue) => issue.signal)).toEqual(['cpu', 'memory', 'gpu', 'gpu']);
  });
});
