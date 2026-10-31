import type * as Cesium from 'cesium';

/**
 * Adaptive render-quality governor.
 *
 * The quality tiers (lib/graphicsQuality) are static: the GPU-based picker
 * puts discrete cards on 'high', but even an RTX 5090 misses 60 fps at
 * 1080p with the full photoreal scene (measured on cat-bed, CDP A/B):
 * the frame budget goes into Cesium draw-command processing — the sun
 * shadow pass roughly doubles per-frame command work, and the tileset /
 * globe screen-space-error budgets set how many commands exist at all.
 *
 *   tier 'high' defaults                ~18-36 fps, ~1540 commands/frame
 *   + MSAA off                          +2..5 fps
 *   + globe SSE 2→4                     +12 fps
 *   + tileset SSE 16→24→32              +8..11 fps
 *   + sun shadow map off                +5 fps
 *   + tileset SSE 48                    +11 fps   →  ~56-57 fps sustained
 *
 * The governor watches real frame times and steps these knobs down one at a
 * time — cheapest visual trade first — until the frame budget holds. It is
 * a floor under the user's tier, never a ceiling: it only lowers values the
 * tier set, never raises them, and never steps back up mid-ride (no
 * oscillation). A quality-tier change or a new viewer recreates it at
 * level 0.
 *
 * Pure logic over injected deps, so vitest can drive it without Cesium.
 */

/** Mean frame-time budget, ms. ~18 ms ≈ 55 fps (the demo acceptance bar). */
export const PERF_BUDGET_MS = 18;
/** How often the rolling window is evaluated, ms. */
export const PERF_EVAL_EVERY_MS = 2_000;
/** Minimum gap between degrade steps — tiles need time to re-settle. */
export const PERF_STEP_COOLDOWN_MS = 3_000;
/** Consecutive over-budget windows required before a step (ignores load spikes). */
export const PERF_HYSTERESIS = 2;
/** Frame deltas above this are idling (request-render mode, tab-out), not slow frames. */
const MAX_COUNTED_FRAME_MS = 250;

export interface PerfGovernorDeps {
  viewer: Cesium.Viewer;
  /** Live 3D tilesets whose detail the governor may reduce (photoreal, OSM). */
  getTilesets: () => (Cesium.Cesium3DTileset | null | undefined)[];
}

export interface PerfGovernorOptions {
  budgetMs?: number;
  evalEveryMs?: number;
  cooldownMs?: number;
  hysteresis?: number;
}

export interface PerfGovernorState {
  /** 0 = tier defaults untouched; N = N degrade steps consumed. */
  level: number;
  /** Names of the applied steps, in order. */
  steps: string[];
  /** Mean frame ms of the most recent evaluated window. */
  lastAvgFrameMs: number | null;
  disposed: boolean;
}

export interface PerfGovernor {
  /** Call once per rendered frame (e.g. from scene.preRender). */
  frame(nowMs: number): void;
  state(): PerfGovernorState;
  dispose(): void;
}

interface Step {
  name: string;
  /** Returns false when the step doesn't apply (skipped, not counted). */
  apply(deps: PerfGovernorDeps): boolean;
}

/** Raise every tileset's SSE to at least `sse` (coarser tiles, fewer commands). */
function raiseTilesetSse(deps: PerfGovernorDeps, sse: number): boolean {
  let changed = 0;
  for (const t of deps.getTilesets()) {
    if (t && !t.isDestroyed() && t.maximumScreenSpaceError < sse) {
      t.maximumScreenSpaceError = sse;
      changed++;
    }
  }
  return changed > 0;
}

/** Degrade ladder — measured (fps gain, visual cost) order; see header. */
const STEPS: Step[] = [
  {
    // FXAA stays on; MSAA×4→1 is a subtle edge-quality change.
    name: 'msaa-off',
    apply: (d) => {
      const s = d.viewer.scene;
      if (!s.msaaSupported || s.msaaSamples <= 1) return false;
      s.msaaSamples = 1;
      return true;
    },
  },
  {
    // Terrain quadtree detail (the 'low' tier value). Under the photoreal
    // drape the globe surface is barely visible; one of the biggest single
    // wins in the cat-bed A/B.
    name: 'globe-sse-4',
    apply: (d) => {
      const g = d.viewer.scene.globe;
      if (g.maximumScreenSpaceError >= 4) return false;
      g.maximumScreenSpaceError = 4;
      return true;
    },
  },
  {
    // The 'medium' then 'low' tier tile detail.
    name: 'tileset-sse-24',
    apply: (d) => raiseTilesetSse(d, 24),
  },
  {
    name: 'tileset-sse-32',
    apply: (d) => raiseTilesetSse(d, 32),
  },
  {
    // Sun shadow map: a second command-processing pass over every caster.
    // The most visible trade (no cast shadows), so it comes late. The blob
    // shadow under the rider is separate and stays.
    name: 'shadow-map-off',
    apply: (d) => {
      const v = d.viewer;
      if (!v.scene.shadowMap || !v.scene.shadowMap.enabled) return false;
      v.shadows = false;
      v.scene.shadowMap.enabled = false;
      return true;
    },
  },
  {
    // Below the tier floor — the single biggest remaining win on the 5090.
    name: 'tileset-sse-48',
    apply: (d) => raiseTilesetSse(d, 48),
  },
  {
    // Last resort: fewer rendered pixels (the 'low' tier scale).
    name: 'resolution-scale-075',
    apply: (d) => {
      const v = d.viewer;
      if (!(v.resolutionScale > 0.75)) return false;
      v.resolutionScale = 0.75;
      return true;
    },
  },
];

export function createPerfGovernor(
  deps: PerfGovernorDeps,
  options: PerfGovernorOptions = {},
): PerfGovernor {
  const budgetMs = options.budgetMs ?? PERF_BUDGET_MS;
  const evalEveryMs = options.evalEveryMs ?? PERF_EVAL_EVERY_MS;
  const cooldownMs = options.cooldownMs ?? PERF_STEP_COOLDOWN_MS;
  const hysteresis = options.hysteresis ?? PERF_HYSTERESIS;

  let level = 0;
  const appliedSteps: string[] = [];
  let disposed = false;

  let lastFrameMs: number | null = null;
  let windowStartMs = 0;
  let windowSumMs = 0;
  let windowFrames = 0;
  let lastAvgFrameMs: number | null = null;
  let badStreak = 0;
  let lastStepMs = Number.NEGATIVE_INFINITY;

  function frame(nowMs: number): void {
    if (disposed) return;
    if (deps.viewer.isDestroyed()) {
      disposed = true;
      return;
    }

    if (lastFrameMs !== null) {
      const dt = nowMs - lastFrameMs;
      if (dt > 0 && dt <= MAX_COUNTED_FRAME_MS) {
        windowSumMs += dt;
        windowFrames++;
      }
    }
    lastFrameMs = nowMs;
    if (windowStartMs === 0) windowStartMs = nowMs;

    if (nowMs - windowStartMs < evalEveryMs) return;

    // Evaluate the window.
    const avg = windowFrames > 0 ? windowSumMs / windowFrames : null;
    windowSumMs = 0;
    windowFrames = 0;
    windowStartMs = nowMs;
    if (avg === null) return;
    lastAvgFrameMs = avg;

    if (level >= STEPS.length) return;

    if (avg > budgetMs) badStreak++;
    else badStreak = 0;

    if (badStreak < hysteresis) return;
    if (nowMs - lastStepMs < cooldownMs) return;

    // Step down — skipping steps that don't apply to this scene.
    while (level < STEPS.length) {
      const step = STEPS[level];
      level++;
      let applied = false;
      try {
        applied = step.apply(deps);
      } catch {
        applied = false; // torn-down scene object — treat as skipped
      }
      if (applied) {
        appliedSteps.push(step.name);
        lastStepMs = nowMs;
        badStreak = 0;
        break;
      }
    }
  }

  return {
    frame,
    state: () => ({
      level,
      steps: [...appliedSteps],
      lastAvgFrameMs,
      disposed,
    }),
    dispose: () => {
      disposed = true;
    },
  };
}
