/**
 * perfWatch.ts — the hourly health sample behind the settings status and the `-perf` topic.
 *
 * The sample is cheap: one `PerformanceObserver` counts main-thread long tasks, the sea's
 * own frame loop counts drawn frames, and `performance.memory` gives the JS heap where the
 * browser exposes it. Nothing runs per frame beyond a few integer adds, and nothing is
 * reported until a reading crosses its threshold.
 *
 * There is no browser API for GPU utilisation. The sea's own evidence stands in for it: a
 * frame drawn while its pose is settled is GPU work with no visible result, and a share of
 * drawn frames arriving slower than `slowFrameMs` is a renderer that cannot keep 40 fps.
 *
 * Delivery is injected so this module stays free of UI imports; `routes.tsx` hands the
 * warning to `stts` under the `-perf` scope, which files it as a notice on that topic.
 */

/** Where one warning goes, e.g. `stts(message, '-perf', 'warning')`. */
export type PerfReport = (message: string) => void;

/** The cadence and the thresholds a reading is judged by. */
export const PERF_WATCH = {
  /** Time to the first report: long enough for the sea to settle and a load to show. */
  firstReportMs: 5 * 60_000,
  /** Reports after the first. */
  reportEachMs: 60 * 60_000,
  /** A window shorter than this is not judged: a first sample carries too little. */
  minWindowMs: 60_000,
  /** Share of the window the main thread may spend in long tasks. */
  cpuBlockedShare: 0.12,
  /** Share of the JS heap's own ceiling that counts as high. */
  memoryUsedShare: 0.8,
  /** A drawn frame later than this has missed 40 fps. */
  slowFrameMs: 25,
  /** Share of drawn frames allowed to be slow. */
  slowFrameShare: 0.25,
  /** Drawn frames below which the slow-frame share says nothing. */
  minFrames: 300,
  /** Drawn frames with a settled pose, per second, that count as drawing for nothing. */
  idleDrawsPerSec: 10,
} as const;

/** One window's readings, as the evaluator takes them. */
export interface PerfSample {
  /** Wall time the readings cover. */
  windowMs: number;
  /** Main-thread time in long tasks, beyond each task's first 50 ms. */
  blockingMs: number;
  /** Long tasks seen in the window. */
  longTasks: number;
  /** JS heap in use, where the browser exposes it. */
  heapUsed?: number;
  /** The heap's own ceiling, where the browser exposes it. */
  heapLimit?: number;
  /** Frames the sea drew. */
  frames: number;
  /** Drawn frames that arrived more than {@link PERF_WATCH.slowFrameMs} after the last. */
  slowFrames: number;
  /** Drawn frames whose pose had not changed since the previous drawn frame. */
  idleFrames: number;
}

/** The resource a reading is about. */
export type PerfSignal = 'cpu' | 'gpu' | 'memory';

/** One threshold a sample crossed. */
export interface PerfIssue {
  signal: PerfSignal;
  /** One line naming the reading and its value. */
  text: string;
}

/** A share as whole percent. */
const pct = (n: number): string => `${Math.round(n * 100)}%`;

/** Bytes as GiB, the unit the heap ceiling is read in. */
const gib = (n: number): string => `${(n / 1024 ** 3).toFixed(1)} GiB`;

/** A window as whole minutes. */
const mins = (ms: number): string => `${Math.round(ms / 60_000)}m`;

/**
 * Judge one window's readings against the thresholds.
 *
 * @param sample the readings
 * @returns every threshold the sample crossed, in a fixed signal order
 */
export function perfIssues(sample: PerfSample): PerfIssue[] {
  const issues: PerfIssue[] = [];

  if (sample.windowMs >= PERF_WATCH.minWindowMs) {
    const blocked = sample.blockingMs / sample.windowMs;
    if (blocked > PERF_WATCH.cpuBlockedShare) {
      issues.push({
        signal: 'cpu',
        text: `cpu blocked ${pct(blocked)} of ${mins(sample.windowMs)}`
          + ` (${sample.longTasks} long task(s))`,
      });
    }
  }

  if (sample.heapUsed !== undefined && sample.heapLimit !== undefined && sample.heapLimit > 0) {
    const used = sample.heapUsed / sample.heapLimit;
    if (used > PERF_WATCH.memoryUsedShare) {
      issues.push({
        signal: 'memory',
        text: `memory heap ${pct(used)} (${gib(sample.heapUsed)} of ${gib(sample.heapLimit)})`,
      });
    }
  }

  if (sample.frames >= PERF_WATCH.minFrames) {
    const slow = sample.slowFrames / sample.frames;
    if (slow > PERF_WATCH.slowFrameShare) {
      issues.push({
        signal: 'gpu',
        text: `gpu ${pct(slow)} of ${sample.frames} frame(s) over ${PERF_WATCH.slowFrameMs}ms`,
      });
    }
  }

  const idleRate = sample.idleFrames / Math.max(1, sample.windowMs / 1000);
  if (idleRate > PERF_WATCH.idleDrawsPerSec) {
    issues.push({
      signal: 'gpu',
      text: `gpu sea drew ${Math.round(idleRate)}/s with nothing moving`,
    });
  }

  return issues;
}

/** The counters the frame loop and the observer fill between reports. */
let windowStart = 0;
let blockingMs = 0;
let longTasks = 0;
let frames = 0;
let slowFrames = 0;
let idleFrames = 0;
let longTaskObserver: PerformanceObserver | null = null;
let running = false;

/**
 * Count one frame of the sea's loop. A skipped frame is not work and is not counted.
 *
 * @param dtMs milliseconds since the previous frame
 * @param drawn whether the frame was drawn
 * @param still whether the previous drawn frame had the same pose
 */
export function noteSeaFrame(dtMs: number, drawn: boolean, still: boolean): void {
  if (!drawn) return;
  frames++;
  if (dtMs > PERF_WATCH.slowFrameMs) slowFrames++;
  if (still) idleFrames++;
}

/** The JS heap, in the browsers that expose it. */
function readHeap(): { used: number; limit: number } | null {
  const memory = (performance as Performance & {
    memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number };
  }).memory;
  if (memory === undefined || !(memory.jsHeapSizeLimit > 0)) return null;
  return { used: memory.usedJSHeapSize, limit: memory.jsHeapSizeLimit };
}

/** Count long tasks from now on; a browser without the entry type leaves the reading absent. */
function observeLongTasks(): void {
  if (typeof PerformanceObserver === 'undefined') return;
  try {
    longTaskObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        longTasks++;
        blockingMs += Math.max(0, entry.duration - 50);
      }
    });
    longTaskObserver.observe({ entryTypes: ['longtask'] });
  } catch {
    /* The entry type is not supported; the CPU reading then stays at zero. */
    longTaskObserver = null;
  }
}

/** Take the window's readings, reset them, and report one line when anything crossed. */
function reportSample(report: PerfReport): void {
  const now = Date.now();
  const heap = readHeap();
  const issues = perfIssues({
    windowMs: now - windowStart,
    blockingMs,
    longTasks,
    frames,
    slowFrames,
    idleFrames,
    ...(heap === null ? {} : { heapUsed: heap.used, heapLimit: heap.limit }),
  });
  windowStart = now;
  blockingMs = 0;
  longTasks = 0;
  frames = 0;
  slowFrames = 0;
  idleFrames = 0;
  if (issues.length === 0) return;
  report(`warn ${issues.map((issue) => issue.text).join(' · ')}`);
}

/**
 * Start the sample. A second call is ignored, so a remount does not stack observers.
 *
 * @param report where one warning line goes
 */
export function startPerfWatch(report: PerfReport): void {
  if (running) return;
  running = true;
  windowStart = Date.now();
  observeLongTasks();
  const tick = () => {
    reportSample(report);
    setTimeout(tick, PERF_WATCH.reportEachMs);
  };
  setTimeout(tick, PERF_WATCH.firstReportMs);
}
