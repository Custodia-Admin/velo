/**
 * RideSetupWizard — "Build your own ride" on Home.
 *
 * Step 1: Pick route    (city search → generate, a scenic pick, GPX upload)
 * Step 2: Pair trainer  (optional; the Devices page's trainer row + a link to /devices)
 * Step 3: Pace partners (optional AI riders alongside)
 * CTA: Start ride (always enabled; defaults fill in if nothing picked)
 *
 * On-system per docs/design/UI-RULES.md (tokens only; checked by
 * src/test/uiRules.test.ts): paper step cards with hairline sections, tiles
 * styled like the pace partners, targets ≥ h-10, body copy ≥ text-sm.
 */

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertCircle,
  ArrowLeftRight,
  ArrowRight,
  Check,
  ChevronDown,
  Loader2,
  MapPin,
  Route as RouteIcon,
  Search,
  X,
  Repeat,
  RotateCcw,
  Wifi,
  WifiOff,
  type LucideIcon,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { geocode, type GeocodeResult } from '@/lib/geocoder';
import {
  generateRoute,
  RouteGenerationError,
  type GeneratedShape,
  type GenerationPhase,
  type RouteGenerationCode,
} from '@/lib/routeGenerator';
import { useRideStore } from '@/stores/rideStore';
import { useSettingsStore } from '@/stores/settingsStore';
import type { Route } from '@/types';
// Lazy: the scenic route catalog (@/lib/scenicRoutes) is fetched on first
// mount of the route step + on demand inside handleStartRide. Keeps the
// geometry off the critical bundle (only its type is imported here).
import type { ScenicRouteInfo } from '@/lib/scenicRoutes';
import { GPXUploader } from '@/components/setup/GPXUploader';
import { PacePartners } from '@/components/velo/PacePartners';
import { scenicFigures } from '@/components/velo/ScenicRoutes';
import { DISPLAY } from '@/components/velo/v2';
import { TrainerRow } from '@/components/velo/TrainerPanel';
import { RoutePreview } from '@/components/setup/RoutePreview';

// ─── Types ────────────────────────────────────────────────────────────────────

type WizardStep = 1 | 2 | 3;

// ─── Persistence ──────────────────────────────────────────────────────────────

/**
 * SessionStorage key for the route-step search + params snapshot. We keep the
 * shape narrow so reading invalid data after a code change degrades to
 * "no restore" rather than throwing.
 */
const ROUTE_STEP_STORAGE_KEY = 'globeride.routeStep.v1';

interface RouteStepPersisted {
  query: string;
  place: GeocodeResult | null;
  shape: GeneratedShape;
  lengthKm: number;
  headingDeg: number;
}

const DEFAULT_LENGTH_KM = 30;
const DEFAULT_HEADING_DEG = 0;

function loadPersistedRouteStep(): Partial<RouteStepPersisted> | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(ROUTE_STEP_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<RouteStepPersisted>;
    // Validate the values we trust before passing them downstream.
    const out: Partial<RouteStepPersisted> = {};
    if (typeof parsed.query === 'string') out.query = parsed.query;
    if (parsed.place && typeof parsed.place === 'object') {
      const p = parsed.place as GeocodeResult;
      if (Number.isFinite(p.lat) && Number.isFinite(p.lon)) out.place = p;
    }
    if (parsed.shape === 'loop' || parsed.shape === 'out-and-back') out.shape = parsed.shape;
    if (typeof parsed.lengthKm === 'number' && Number.isFinite(parsed.lengthKm)) {
      out.lengthKm = Math.max(2, Math.min(80, parsed.lengthKm));
    }
    if (typeof parsed.headingDeg === 'number' && Number.isFinite(parsed.headingDeg)) {
      out.headingDeg = ((parsed.headingDeg % 360) + 360) % 360;
    }
    return out;
  } catch {
    return null;
  }
}

function savePersistedRouteStep(snapshot: RouteStepPersisted): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(ROUTE_STEP_STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    // Quota exceeded / disabled — silently no-op.
  }
}

// ─── Step card ────────────────────────────────────────────────────────────────

/** One wizard step: a paper panel, lifted while open. */
function stepCard(open: boolean): string {
  return cn('rounded-lg border border-border bg-card transition-shadow duration-200', open && 'shadow-sm');
}

// ─── Step badge ───────────────────────────────────────────────────────────────

function StepCircle({
  n,
  done,
  active,
}: {
  n: WizardStep;
  done: boolean;
  active: boolean;
}) {
  return (
    <span
      className={cn(
        'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-bold transition-colors duration-150',
        done
          ? 'bg-primary text-primary-foreground'
          : active
            ? 'bg-primary/15 text-primary'
            : 'bg-muted text-muted-foreground',
      )}
    >
      {n}
    </span>
  );
}

// ─── Step header row ─────────────────────────────────────────────────────────

function StepHeader({
  n,
  title,
  subtitle,
  done,
  active,
  onClick,
}: {
  n: WizardStep;
  title: string;
  subtitle?: string;
  done: boolean;
  active: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={active}
      className="flex min-h-12 w-full items-center gap-3 rounded-md text-left"
    >
      <StepCircle n={n} done={done} active={active} />
      <div className="min-w-0 flex-1">
        <div className={cn('text-base font-semibold', active || done ? 'text-foreground' : 'text-muted-foreground')}>
          {title}
        </div>
        {subtitle && <div className="truncate text-sm text-muted-foreground">{subtitle}</div>}
      </div>
      <ChevronDown
        aria-hidden
        className={cn('h-5 w-5 shrink-0 transition-transform duration-150', active ? 'rotate-180 text-primary' : 'text-muted-foreground')}
      />
    </button>
  );
}

// ─── Step 1: Route picker ─────────────────────────────────────────────────────

interface RouteStepProps {
  onRouteSelected: () => void;
}

/** Human-friendly status text for each generation phase. */
const PHASE_LABEL: Record<GenerationPhase, string> = {
  routing: 'Routing real roads…',
  smoothing: 'Smoothing…',
  elevation: 'Sampling elevation…',
  done: 'Route ready',
};

function RouteStep({ onRouteSelected }: RouteStepProps) {
  const setRoute = useRideStore((s) => s.setRoute);
  const requestFlyTo = useRideStore((s) => s.requestFlyTo);
  const currentRoute = useRideStore((s) => s.route);
  const units = useSettingsStore((s) => s.units);

  // Featured Easy & Scenic rides — lazy-loaded so the route geometry stays
  // off the critical bundle. `null` means "still importing"; render skeleton
  // cards until the module resolves on first mount.
  const [featuredRoutes, setFeaturedRoutes] = useState<ScenicRouteInfo[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    import('@/lib/scenicRoutes')
      .then((m) => {
        if (!cancelled) {
          // Closest first: Perugia, then the Ticino hometown rides.
          setFeaturedRoutes(m.homeFirstScenicRoutes().slice(0, 6));
        }
      })
      .catch(() => { if (!cancelled) setFeaturedRoutes([]); });
    return () => { cancelled = true; };
  }, []);

  // Restore persisted snapshot on first render so a reload doesn't wipe state.
  const persistedRef = useRef<Partial<RouteStepPersisted> | null>(null);
  if (persistedRef.current === null) {
    persistedRef.current = loadPersistedRouteStep() ?? {};
  }
  const persisted = persistedRef.current;

  // Search state
  const [query, setQuery] = useState<string>(persisted.query ?? '');
  const [results, setResults] = useState<GeocodeResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [showResults, setShowResults] = useState(false);
  const [selected, setSelected] = useState<GeocodeResult | null>(persisted.place ?? null);
  const [searchError, setSearchError] = useState<string | null>(null);

  // Generation state
  const [shape, setShape] = useState<GeneratedShape>(persisted.shape ?? 'out-and-back');
  const [lengthKm, setLengthKm] = useState<number>(persisted.lengthKm ?? DEFAULT_LENGTH_KM);
  const [headingDeg, setHeadingDeg] = useState<number>(persisted.headingDeg ?? DEFAULT_HEADING_DEG);
  const [generating, setGenerating] = useState(false);
  const [phase, setPhase] = useState<GenerationPhase | null>(null);
  const [genError, setGenError] = useState<{ message: string; allowSynthetic: boolean } | null>(null);

  // Preview state — route is held here until the user commits with "Use this route".
  const [previewRoute, setPreviewRoute] = useState<Route | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const genAbortRef = useRef<AbortController | null>(null);

  // Persist snapshot whenever the relevant params change.
  useEffect(() => {
    savePersistedRouteStep({ query, place: selected, shape, lengthKm, headingDeg });
  }, [query, selected, shape, lengthKm, headingDeg]);

  // Nominatim search with debounce
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setResults([]); setSearchError(null); return; }
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const t = setTimeout(async () => {
      setSearching(true);
      setSearchError(null);
      try {
        const r = await geocode(q, { signal: ctrl.signal });
        if (!ctrl.signal.aborted) { setResults(r); setShowResults(true); }
      } catch (err) {
        if (ctrl.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) return;
        setSearchError(err instanceof Error ? err.message : 'Search failed');
        setResults([]);
      } finally {
        if (!ctrl.signal.aborted) setSearching(false);
      }
    }, 350);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [query]);

  // Cancel any in-flight generation when the component unmounts.
  useEffect(() => () => genAbortRef.current?.abort(), []);

  // A generation still running belongs to the place being left: drop it, or
  // its route would preview (and commit) under the next place's name.
  const cancelGenerate = useCallback(() => {
    genAbortRef.current?.abort();
    genAbortRef.current = null;
    setGenerating(false);
    setPhase(null);
  }, []);

  const onPlaceSelect = useCallback(
    (r: GeocodeResult) => {
      cancelGenerate();
      setSelected(r);
      setShowResults(false);
      setGenError(null);
      setPreviewRoute(null);
      requestFlyTo({ lat: r.lat, lon: r.lon, boundingBox: r.boundingBox, label: r.shortName });
    },
    [requestFlyTo, cancelGenerate],
  );

  const runGenerate = useCallback(
    async (useSynthetic: boolean) => {
      if (!selected) return;
      // Cancel any in-flight generation before starting a new one.
      genAbortRef.current?.abort();
      const ctrl = new AbortController();
      genAbortRef.current = ctrl;

      setGenerating(true);
      setPhase('routing');
      setGenError(null);
      setPreviewRoute(null);
      try {
        let terrainProvider = null;
        try {
          // On demand: keeps Cesium out of the /app bundle.
          const { getTerrainProvider } = await import('@/lib/cesiumUtils');
          terrainProvider = await getTerrainProvider();
        } catch { /* no token / chunk unavailable */ }
        const route = await generateRoute(
          { lat: selected.lat, lon: selected.lon },
          {
            shape,
            lengthKm,
            headingDeg,
            useSynthetic,
            // Renamed below by the length it really came out at.
            name: selected.shortName,
            terrainProvider,
            signal: ctrl.signal,
            onPhase: (p) => { if (!ctrl.signal.aborted) setPhase(p); },
          },
        );
        if (ctrl.signal.aborted) return;
        setPreviewRoute({ ...route, name: generatedRouteName(selected.shortName, shape, route.totalDistance) });
      } catch (err) {
        if (ctrl.signal.aborted) return;
        if (err instanceof RouteGenerationError) {
          if (err.code === 'aborted') return;
          // Both osrm_no_route and osrm_network are recoverable with synthetic.
          // The unknown bucket also offers it — the user might just want to try.
          setGenError({
            message: generateErrorText(err.code, selected.shortName, err.message),
            allowSynthetic: !useSynthetic,
          });
        } else {
          setGenError({
            message: err instanceof Error ? err.message : 'Could not generate route',
            allowSynthetic: !useSynthetic,
          });
        }
      } finally {
        if (!ctrl.signal.aborted) {
          setGenerating(false);
          setPhase(null);
        }
      }
    },
    [selected, shape, lengthKm, headingDeg],
  );

  const onGenerate = useCallback(() => { void runGenerate(false); }, [runGenerate]);
  const onUseSynthetic = useCallback(() => { void runGenerate(true); }, [runGenerate]);

  const onCommitPreview = useCallback(() => {
    if (!previewRoute) return;
    setRoute(previewRoute);
    setPreviewRoute(null);
    onRouteSelected();
  }, [previewRoute, setRoute, onRouteSelected]);

  const searchId = useId();
  const scenicId = useId();

  return (
    <div className="flex flex-col gap-4">

      {/* City search → a generated route */}
      <div className="flex flex-col gap-2">
        <label htmlFor={searchId} className="text-sm font-semibold text-foreground">
          Search for a place
        </label>
        <div className="relative">
          <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            id={searchId}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => results.length > 0 && setShowResults(true)}
            placeholder="Kyoto, Mont Ventoux…"
            className="h-12 w-full rounded-md border border-border bg-card pl-10 pr-12 text-base text-foreground placeholder:text-muted-foreground"
            spellCheck={false}
            autoComplete="off"
          />
          {searching ? (
            <Loader2 aria-hidden className="absolute right-4 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground" />
          ) : query ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => {
                cancelGenerate();
                setQuery('');
                setResults([]);
                setSelected(null);
                setShowResults(false);
                setPreviewRoute(null);
                setGenError(null);
              }}
              aria-label="Clear search"
              className="absolute right-1 top-1/2 -translate-y-1/2 text-muted-foreground"
            >
              <X className="h-4 w-4" aria-hidden />
            </Button>
          ) : null}

          {/* Search results */}
          {showResults && results.length > 0 && (
            <ul
              aria-label="Places found"
              data-search-results
              className="absolute z-30 mt-1 max-h-72 w-full divide-y divide-border overflow-auto rounded-lg border border-border bg-card shadow-lg dark:border-foreground/15 dark:bg-muted"
            >
              {results.map((r) => (
                <li key={r.placeId}>
                  <button
                    type="button"
                    onClick={() => onPlaceSelect(r)}
                    className="flex min-h-12 w-full items-start gap-3 px-4 py-3 text-left transition-colors duration-150 hover:bg-foreground/5 focus-visible:bg-foreground/5"
                  >
                    <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
                    <span className="flex min-w-0 flex-col">
                      <span className="text-sm font-semibold text-foreground">{r.shortName}</span>
                      <span className="text-sm text-muted-foreground">{resultRegion(r, results)}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {searchError && <ErrorLine>{searchError}</ErrorLine>}

        {/* Route generator for the picked place */}
        {selected && (
          // A borderless inset (no card in the card): everything for this
          // place, down to its preview. The search field's clear button
          // clears the place too, so there is one way to drop it.
          <div className="mt-2 flex flex-col gap-4 rounded-md bg-muted/50 p-4 animate-fadeUp" data-route-generator>
            <div>
              <div className={cn(DISPLAY, 'text-xl text-foreground')}>{selected.shortName}</div>
              <div className="text-sm text-muted-foreground">{placeRegion(selected)}</div>
            </div>

            <div role="group" aria-label="Route shape" className="grid grid-cols-2 gap-2">
              <ShapeButton active={shape === 'out-and-back'} onClick={() => setShape('out-and-back')} icon={ArrowLeftRight} label="Out & back" />
              <ShapeButton active={shape === 'loop'} onClick={() => setShape('loop')} icon={Repeat} label="Loop" />
            </div>

            <RangeRow
              label="Target distance"
              ariaLabel="Route distance in km"
              value={lengthKm}
              display={`${lengthKm} km`}
              min={2}
              max={80}
              onChange={setLengthKm}
            />

            {shape === 'out-and-back' && (
              <RangeRow
                label="Heading"
                ariaLabel="Route heading in degrees"
                value={headingDeg}
                display={`${headingDeg}° ${compassPoint(headingDeg)}`}
                min={0}
                max={359}
                onChange={setHeadingDeg}
              />
            )}

            {genError && <ErrorLine>{genError.message}</ErrorLine>}

            {/* Generate (one filled action: the preview's "Use this route" replaces it) */}
            {(generating || !previewRoute) && (
              <GenerateActions
                generating={generating}
                phaseLabel={phase ? PHASE_LABEL[phase] : null}
                offerRoadFree={!generating && genError?.allowSynthetic === true}
                onGenerate={onGenerate}
                onRoadFree={onUseSynthetic}
              />
            )}
            <span role="status" aria-live="polite" className="sr-only">
              {generating && phase ? PHASE_LABEL[phase] : ''}
            </span>

            {previewRoute && !generating && (
              <RoutePreview
                route={previewRoute}
                onCommit={onCommitPreview}
                onRegenerate={onGenerate}
                regenerating={generating}
              />
            )}
          </div>
        )}
      </div>

      {/* An easy scenic ride: the closest first */}
      <div className="flex flex-col gap-3 border-t border-border pt-4">
        <p id={scenicId} className="text-sm font-semibold text-foreground">
          Or pick an easy scenic ride
        </p>
        <div role="group" aria-labelledby={scenicId} className="grid gap-2 sm:grid-cols-2">
          {featuredRoutes === null
            ? Array.from({ length: 6 }).map((_, i) => (
                <div
                  key={`featured-skeleton-${i}`}
                  aria-hidden
                  className="flex min-h-16 flex-col justify-center gap-2 rounded-md border border-border bg-card px-3 py-2 animate-pulse"
                >
                  <span className="h-4 w-2/3 rounded-sm bg-muted" />
                  <span className="h-3 w-1/2 rounded-sm bg-muted" />
                </div>
              ))
            : featuredRoutes.map((info) => {
                const isSelected = currentRoute?.id === info.route.id;
                return (
                  <button
                    key={info.route.id}
                    type="button"
                    aria-pressed={isSelected}
                    data-featured-route={info.route.id}
                    onClick={() => { setRoute(info.route); onRouteSelected(); }}
                    className={cn(
                      'flex min-h-16 items-center gap-3 rounded-md border px-3 py-2 text-left transition-colors duration-150',
                      isSelected ? 'border-primary bg-primary/10' : 'border-border bg-card hover:border-primary/40',
                    )}
                  >
                    <span className="min-w-0 flex-1">
                      <span className={cn(DISPLAY, 'block text-lg text-foreground')}>{info.name}</span>
                      <span className="num block text-sm text-muted-foreground">{scenicFigures(info, units)}</span>
                    </span>
                    {isSelected && <Check className="h-5 w-5 shrink-0 text-primary" aria-hidden />}
                  </button>
                );
              })}
        </div>
      </div>

      {/* A GPX of the rider's own */}
      <div className="border-t border-border pt-4">
        <GPXUploader />
      </div>
    </div>
  );
}

// ─── Route step helpers ───────────────────────────────────────────────────────

/**
 * A generated route's name, by the length it really came out at: the
 * distance slider is a target (a 30 km ask can route at 36 km), so the name
 * and the preview's figures agree. "Perugia · 36 km out-and-back".
 */
export function generatedRouteName(place: string, shape: GeneratedShape, totalDistanceM: number): string {
  const km = Math.max(1, Math.round(totalDistanceM / 1000));
  return `${place} · ${km} km ${shape === 'loop' ? 'loop' : 'out-and-back'}`;
}

/** "Perugia, Umbria, Italy" under a "Perugia" heading reads "Umbria, Italy". */
export function placeRegion(place: Pick<GeocodeResult, 'shortName' | 'displayName'>): string {
  const rest = place.displayName.split(',').slice(1).map((p) => p.trim()).filter(Boolean).join(', ');
  return rest || place.displayName;
}

/**
 * A search result's second line: its region, plus what the place is when
 * another result reads the same. Nominatim returns Perugia the city and
 * Perugia the county, both "Perugia, Umbria, Italy": "Umbria, Italy · city".
 */
export function resultRegion(
  place: Pick<GeocodeResult, 'shortName' | 'displayName' | 'kind'>,
  all: readonly Pick<GeocodeResult, 'displayName'>[],
): string {
  const region = placeRegion(place);
  const twins = all.filter((r) => r.displayName === place.displayName).length > 1;
  return twins && place.kind ? `${region} · ${place.kind}` : region;
}

/**
 * Why a route didn't generate, in plain words (UI-RULES §6: no "synthetic
 * routing"): both router failures can still draw the route without roads.
 */
export function generateErrorText(code: RouteGenerationCode, place: string, message: string): string {
  if (code === 'osrm_no_route') return `No bike roads near ${place}. Try another place, or draw the route without roads.`;
  if (code === 'osrm_network') return "Couldn't reach the bike router. Try again, or draw the route without roads.";
  return message;
}

/**
 * The generator's actions, one filled button (UI-RULES §7). Normally that is
 * Generate route. After the bike router failed, it is the way that still
 * works, drawing the route without roads, with Try again beside it (outline)
 * for a router that was only out of reach.
 */
export function GenerateActions({
  generating,
  phaseLabel,
  offerRoadFree,
  onGenerate,
  onRoadFree,
}: {
  generating: boolean;
  phaseLabel: string | null;
  offerRoadFree: boolean;
  onGenerate: () => void;
  onRoadFree: () => void;
}) {
  if (offerRoadFree) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" onClick={onRoadFree}>
          <RouteIcon className="h-4 w-4" aria-hidden />
          Draw it without roads
        </Button>
        <Button variant="outline" onClick={onGenerate}>
          <RotateCcw className="h-4 w-4" aria-hidden />
          Try again
        </Button>
      </div>
    );
  }
  return (
    <div>
      <Button variant="primary" onClick={onGenerate} disabled={generating} aria-busy={generating || undefined}>
        {generating
          ? <><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> {phaseLabel ?? 'Generating…'}</>
          : <><RouteIcon className="h-4 w-4" aria-hidden /> Generate route</>}
      </Button>
    </div>
  );
}

/** A plain error sentence (UI-RULES §8): icon + text, no red box. */
function ErrorLine({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="flex items-start gap-1.5 text-sm text-destructive">
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <span>{children}</span>
    </p>
  );
}

/** Out & back / Loop: a two-way toggle, styled like the pace partner tiles. */
function ShapeButton({
  active,
  onClick,
  icon: Icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: LucideIcon;
  label: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'inline-flex h-10 items-center justify-center gap-2 rounded-md border px-3 text-sm font-semibold transition-colors duration-150',
        active ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-card text-foreground hover:border-primary/40',
      )}
    >
      <Icon className="h-4 w-4" aria-hidden />
      {label}
    </button>
  );
}

/** The 8-wind compass point of a heading in degrees: 0 → N, 100 → E, 225 → SW. */
export function compassPoint(deg: number): string {
  const points = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return points[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
}

/** A labelled slider with its value on the right; the slider itself is h-10 to touch. */
function RangeRow({
  label,
  ariaLabel,
  value,
  display,
  min,
  max,
  onChange,
}: {
  label: string;
  ariaLabel: string;
  value: number;
  display: string;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex flex-col">
      {/* As Home's comfort slider: the label strong, the value quiet. */}
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="font-semibold text-foreground">{label}</span>
        <span className="num text-muted-foreground">{display}</span>
      </div>
      <input
        type="range"
        aria-label={ariaLabel}
        aria-valuetext={display}
        min={min}
        max={max}
        step={1}
        value={value}
        onChange={(e) => onChange(parseInt(e.target.value, 10))}
        // h-10 to touch; -my-2 keeps the drawn track close to its label.
        className="-my-2 h-10 w-full"
      />
    </div>
  );
}

// ─── Step 2: Trainer ──────────────────────────────────────────────────────────

/**
 * The Devices page's own trainer row (same pairing, reconnect and guide), as
 * a hairline row of the step card, plus the way to the rest of /devices:
 * handlebar controls, heart rate and the demo rider / ERG options.
 */
function TrainerStep() {
  const navigate = useNavigate();
  const connected = useRideStore((s) => s.connection === 'connected');
  return (
    <div>
      <div className="border-t border-border">
        {/* The row pads sm:px-5; -mx-1 puts its glyph and action on the
            step header's px-4 edges. */}
        <div className="sm:-mx-1">
          <TrainerRow />
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-border px-4 py-2">
        <p className="text-sm text-muted-foreground">
          {/* The demo fallback is said by the row (no Bluetooth) and the Start row ("Demo mode"). */}
          {connected
            ? 'Handlebar controls, heart rate and ERG are on Devices.'
            : 'Handlebar controls and heart rate pair on Devices.'}
        </p>
        <Button variant="textlink" className="px-0" onClick={() => navigate('/devices')}>
          Open Devices
        </Button>
      </div>
    </div>
  );
}

// ─── Step 3: Pace partners ────────────────────────────────────────────────────

function PaceStep() {
  return <PacePartners />;
}

// ─── Main wizard ──────────────────────────────────────────────────────────────

export function RideSetupWizard() {
  const navigate = useNavigate();

  const route = useRideStore((s) => s.route);
  const connection = useRideStore((s) => s.connection);
  // Names of the picked pace partners ('' when riding alone): read from the
  // store, which is what rides.
  const partnerNames = useRideStore((s) => s.paceBots.map((b) => b.name).join(', '));

  // Which step is expanded
  const [openStep, setOpenStep] = useState<WizardStep>(1);

  // Step completion flags
  const step1Done = route !== null;
  const step2Done = connection === 'connected';
  const step3Done = partnerNames !== '';

  // Subtitle text for collapsed steps
  const step1Subtitle = route ? route.name : 'None yet: Start picks an easy scenic ride';
  const step2Subtitle = step2Done ? 'Trainer connected' : 'Demo mode (no trainer)';
  const step3Subtitle = step3Done ? `With ${partnerNames}` : 'Riding alone';

  const handleRouteSelected = useCallback(() => {
    setOpenStep(2);
  }, []);

  const handleStartRide = useCallback(async () => {
    const store = useRideStore.getState();
    // Auto-fill route if still none: an easy scenic ride near home. The
    // catalog is dynamic-imported so it stays off the critical bundle path.
    if (!store.route) {
      const { randomScenicRoute } = await import('@/lib/scenicRoutes');
      store.setRoute(randomScenicRoute().route);
    }
    // Pass autoStart so the ride begins as soon as Cesium is ready — the
    // wizard's "Start ride" CTA should actually start the ride, not just
    // drop the user on a "press Start" screen.
    navigate('/ride', { state: { autoStart: true } });
  }, [navigate]);

  const toggleStep = useCallback(
    (s: WizardStep) => setOpenStep((prev) => (prev === s ? (s === 1 ? 2 : 1) : s)),
    [],
  );

  return (
    <div className="flex flex-col gap-3">

      {/* ── Step 1: Route ── */}
      <div
        className={stepCard(openStep === 1)}
        data-wizard-step={1}
      >
        <div className="px-4 py-2">
          <StepHeader
            n={1}
            title="Choose your route"
            subtitle={openStep !== 1 ? step1Subtitle : undefined}
            done={step1Done}
            active={openStep === 1}
            onClick={() => toggleStep(1)}
          />
        </div>

        {openStep === 1 && (
          <div className="px-4 pb-4">
            <RouteStep onRouteSelected={handleRouteSelected} />
          </div>
        )}
      </div>

      {/* ── Step 2: Trainer (collapsible) ── */}
      <div
        className={stepCard(openStep === 2)}
        data-wizard-step={2}
      >
        <div className="px-4 py-2">
          <StepHeader
            n={2}
            title={
              step2Done
                ? 'Trainer connected'
                : 'Pair trainer'
            }
            subtitle={openStep !== 2 ? step2Subtitle : undefined}
            done={step2Done}
            active={openStep === 2}
            onClick={() => toggleStep(2)}
          />
        </div>

        {openStep === 2 && <TrainerStep />}
      </div>

      {/* ── Step 3: Pace partners (collapsible) ── */}
      <div
        className={stepCard(openStep === 3)}
        data-wizard-step={3}
      >
        <div className="px-4 py-2">
          <StepHeader
            n={3}
            title="Pace partners"
            subtitle={openStep !== 3 ? step3Subtitle : undefined}
            done={step3Done}
            active={openStep === 3}
            onClick={() => toggleStep(3)}
          />
        </div>

        {openStep === 3 && (
          <div className="px-4 pb-4">
            <PaceStep />
          </div>
        )}
      </div>

      {/* ── Start CTA ── */}
      <div className="flex flex-col items-start gap-3 pt-1 sm:flex-row sm:items-center">
        <Button size="lg" variant="primary" onClick={handleStartRide} className="w-full text-base sm:w-auto">
          {step1Done ? 'Start ride' : 'Auto-pick a route & start'}
          <ArrowRight className="h-5 w-5" />
        </Button>

        {/* Connection status: what drives the ride */}
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          {step2Done
            ? <><Wifi className="h-4 w-4 text-primary" aria-hidden /> Trainer connected</>
            : <><WifiOff className="h-4 w-4" aria-hidden /> Demo mode</>}
        </div>
      </div>
    </div>
  );
}
