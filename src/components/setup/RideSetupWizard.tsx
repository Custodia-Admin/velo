/**
 * RideSetupWizard — "Build your own ride" on Home.
 *
 * Step 1: Pick route    (city search → generate, a scenic pick, GPX upload)
 * Step 2: Pair trainer  (optional; the Devices screen does the same)
 * Step 3: Pace partners (optional AI riders alongside)
 * CTA: Start ride (always enabled; defaults fill in if nothing picked)
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowRight,
  Check,
  ChevronDown,
  Loader2,
  MapPin,
  Route as RouteIcon,
  Search,
  Upload,
  X,
  Repeat,
  Compass,
  Wifi,
  WifiOff,
  Mountain,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { geocode, type GeocodeResult } from '@/lib/geocoder';
import {
  generateRoute,
  RouteGenerationError,
  type GeneratedShape,
  type GenerationPhase,
} from '@/lib/routeGenerator';
import { useRideStore } from '@/stores/rideStore';
import type { Route } from '@/types';
// Lazy: the scenic route catalog (@/lib/scenicRoutes) is fetched on first
// mount of the route step + on demand inside handleStartRide. Keeps the
// geometry off the critical bundle.

interface FeaturedRoute {
  route: Route;
  title: string;
}
import { TrainerConnect } from '@/components/trainer/TrainerConnect';
import { GPXUploader } from '@/components/setup/GPXUploader';
import { PacePartners } from '@/components/velo/PacePartners';
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

  // Featured Easy & Scenic rides — lazy-loaded so the route geometry stays
  // off the critical bundle. `null` means "still importing"; render skeleton
  // cards until the module resolves on first mount.
  const [featuredRoutes, setFeaturedRoutes] = useState<FeaturedRoute[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    import('@/lib/scenicRoutes')
      .then((m) => {
        if (!cancelled) {
          setFeaturedRoutes(
            // Closest first: Perugia, then the Ticino hometown rides.
            [
              ...m.SCENIC_ROUTES.filter((r) => r.area === 'near-home'),
              ...m.SCENIC_ROUTES.filter((r) => r.area === 'hometown'),
            ]
              .slice(0, 6)
              .map((r) => ({ route: r.route, title: r.name })),
          );
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

  // GPX upload expansion
  const [showGpx, setShowGpx] = useState(false);

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

  const onPlaceSelect = useCallback(
    (r: GeocodeResult) => {
      setSelected(r);
      setShowResults(false);
      setGenError(null);
      setPreviewRoute(null);
      requestFlyTo({ lat: r.lat, lon: r.lon, boundingBox: r.boundingBox, label: r.shortName });
    },
    [requestFlyTo],
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
            name:
              shape === 'loop'
                ? `${selected.shortName} · ${lengthKm} km loop`
                : `${selected.shortName} · ${lengthKm} km out-and-back`,
            terrainProvider,
            signal: ctrl.signal,
            onPhase: (p) => { if (!ctrl.signal.aborted) setPhase(p); },
          },
        );
        if (ctrl.signal.aborted) return;
        setPreviewRoute(route);
      } catch (err) {
        if (ctrl.signal.aborted) return;
        if (err instanceof RouteGenerationError) {
          if (err.code === 'aborted') return;
          // Both osrm_no_route and osrm_network are recoverable with synthetic.
          // The unknown bucket also offers it — the user might just want to try.
          setGenError({
            message:
              err.code === 'osrm_no_route'
                ? `No bike roads near ${selected.shortName}. Try a different location or use synthetic routing.`
                : err.message,
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

  return (
    <div className="flex flex-col gap-4">

      {/* City search */}
      <div className="flex flex-col gap-2">
        <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
          Search any city or place
        </div>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <input
            type="search"
            aria-label="Search for a place"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => results.length > 0 && setShowResults(true)}
            placeholder='"Mont Ventoux", "Staunton VA", "Kyoto"…'
            className="w-full rounded-lg border border-border bg-muted/35 pl-9 pr-9 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/55 focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary/40 transition-colors"
            spellCheck={false}
            autoComplete="off"
          />
          {searching ? (
            <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground animate-spin" />
          ) : query ? (
            <button
              type="button"
              onClick={() => {
                setQuery('');
                setResults([]);
                setSelected(null);
                setShowResults(false);
                setPreviewRoute(null);
              }}
              aria-label="Clear"
              className="absolute right-2 top-1/2 -translate-y-1/2 h-6 w-6 rounded-full text-muted-foreground hover:text-foreground hover:bg-muted/60 inline-flex items-center justify-center transition-colors"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          ) : null}

          {/* Results dropdown */}
          {showResults && results.length > 0 && (
            <ul
              role="listbox"
              className="absolute z-30 mt-1.5 max-h-64 w-full overflow-auto rounded-xl border border-border bg-card shadow-lg ring-1 ring-border/40 divide-y divide-border/40"
            >
              {results.map((r) => (
                <li key={r.placeId}>
                  <button
                    type="button"
                    onClick={() => onPlaceSelect(r)}
                    className="w-full text-left px-3 py-2.5 hover:bg-muted/50 focus:bg-muted/50 outline-none flex items-start gap-2 transition-colors"
                  >
                    <MapPin className="h-4 w-4 text-primary mt-0.5 shrink-0" />
                    <div className="flex flex-col min-w-0">
                      <span className="text-sm text-foreground truncate">{r.shortName}</span>
                      <span className="text-xs text-muted-foreground truncate">{r.displayName}</span>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {searchError && (
          <div className="rounded-lg border border-destructive/35 bg-destructive/8 px-3 py-2 text-xs text-destructive">
            {searchError}
          </div>
        )}

        {/* Route generator panel */}
        {selected && (
          <div className="rounded-xl border border-border/70 bg-card/45 p-3.5 flex flex-col gap-3 animate-fadeUp">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="text-sm font-semibold text-foreground truncate">{selected.shortName}</div>
                <div className="text-xs text-muted-foreground truncate">{selected.displayName}</div>
              </div>
              <button
                type="button"
                onClick={() => {
                  setSelected(null);
                  setQuery('');
                  setPreviewRoute(null);
                  setGenError(null);
                }}
                aria-label="Clear selection"
                className="rounded-md p-1 text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors shrink-0"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <ShapeButton active={shape === 'out-and-back'} onClick={() => setShape('out-and-back')} icon={<Repeat className="h-4 w-4" />} label="Out & back" />
              <ShapeButton active={shape === 'loop'} onClick={() => setShape('loop')} icon={<RouteIcon className="h-4 w-4" />} label="Loop" />
            </div>

            <div className="flex flex-col gap-1">
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">Distance</span>
                <span className="num font-semibold text-foreground">{lengthKm} km</span>
              </div>
              <input
                type="range"
                aria-label="Route distance in km"
                min={2} max={80} step={1}
                value={lengthKm}
                onChange={(e) => setLengthKm(parseInt(e.target.value, 10))}
                className="w-full"
              />
            </div>

            {shape === 'out-and-back' && (
              <div className="flex flex-col gap-1">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground flex items-center gap-1"><Compass className="h-3 w-3" /> Heading</span>
                  <span className="num font-semibold text-foreground">{headingDeg}°</span>
                </div>
                <input
                  type="range"
                  aria-label="Route heading in degrees"
                  min={0} max={359} step={1}
                  value={headingDeg}
                  onChange={(e) => setHeadingDeg(parseInt(e.target.value, 10))}
                  className="w-full"
                />
              </div>
            )}

            {genError && (
              <div className="rounded-lg border border-destructive/35 bg-destructive/8 px-3 py-2 text-xs text-destructive flex flex-col gap-2">
                <span>{genError.message}</span>
                {genError.allowSynthetic && (
                  <div>
                    <Button variant="outline" size="sm" onClick={onUseSynthetic} disabled={generating}>
                      Use synthetic routing instead
                    </Button>
                  </div>
                )}
              </div>
            )}

            {/* Generate button + phase progress */}
            <div className="flex items-center gap-2 flex-wrap">
              <Button variant="default" onClick={onGenerate} disabled={generating} className="self-start">
                {generating
                  ? <><Loader2 className="h-4 w-4 animate-spin" /> {phase ? PHASE_LABEL[phase] : 'Generating…'}</>
                  : <><RouteIcon className="h-4 w-4" /> Generate route</>}
              </Button>
              {generating && phase && (
                <span
                  role="status"
                  aria-live="polite"
                  className="text-[11px] text-muted-foreground"
                >
                  {PHASE_LABEL[phase]}
                </span>
              )}
            </div>

            {/* Preview card */}
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

      {/* Divider */}
      <div className="flex items-center gap-3">
        <div className="h-px flex-1 bg-border/50" />
        <span className="text-2xs uppercase tracking-widest text-muted-foreground">or choose an easy scenic ride</span>
        <div className="h-px flex-1 bg-border/50" />
      </div>

      {/* Featured iconic routes — 2-column grid. Skeleton cards stay in
          place until the dynamic-imported catalog resolves. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {featuredRoutes === null
          ? Array.from({ length: 6 }).map((_, i) => (
              <div
                key={`featured-skeleton-${i}`}
                aria-hidden
                className="flex items-start gap-3 rounded-xl border border-border/40 bg-card/20 px-3.5 py-3 animate-pulse"
              >
                <span className="mt-0.5 h-8 w-8 shrink-0 rounded-lg bg-muted/40" />
                <div className="flex-1 min-w-0 space-y-1.5">
                  <div className="h-3 w-2/3 rounded bg-muted/40" />
                  <div className="h-2.5 w-1/2 rounded bg-muted/30" />
                </div>
              </div>
            ))
          : featuredRoutes.map((r) => {
              const distKm = r.route.totalDistance ? (r.route.totalDistance / 1000).toFixed(1) : '—';
              const ascentM = r.route.ascent ? Math.round(r.route.ascent) : null;
              const isSelected = currentRoute?.id === r.route.id;
              return (
                <button
                  key={r.route.id}
                  type="button"
                  onClick={() => { setRoute(r.route); onRouteSelected(); }}
                  className={cn(
                    'flex items-start gap-3 rounded-xl border px-3.5 py-3 text-left transition-all',
                    isSelected
                      ? 'border-primary/50 bg-primary/8 ring-1 ring-primary/25'
                      : 'border-border/50 bg-card/30 hover:border-border/80 hover:bg-card/50',
                  )}
                >
                  <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-primary/20 to-accent/10 text-primary">
                    <Mountain className="h-4 w-4" />
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold text-foreground truncate">{r.title}</div>
                    <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground num">
                      <span>{distKm} km</span>
                      {ascentM && <><span className="opacity-40">·</span><span>{ascentM} m</span></>}
                    </div>
                  </div>
                  {isSelected && <Check className="h-4 w-4 text-primary shrink-0 mt-0.5" />}
                </button>
              );
            })}
      </div>

      {/* Own route */}
      <div className="flex flex-wrap items-center gap-3 pt-1">
        <button
          type="button"
          onClick={() => setShowGpx((v) => !v)}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1"
        >
          <Upload className="h-3.5 w-3.5" />
          Upload GPX
        </button>
      </div>

      {/* GPX uploader inline */}
      {showGpx && (
        <div className="rounded-xl border border-border/60 bg-muted/10 p-3 animate-fadeUp">
          <GPXUploader />
        </div>
      )}
    </div>
  );
}

// ─── ShapeButton helper ───────────────────────────────────────────────────────

function ShapeButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition-all duration-150',
        active
          ? 'border-primary/50 bg-primary/12 text-primary ring-1 ring-primary/20'
          : 'border-border/70 bg-card/40 text-muted-foreground hover:text-foreground hover:bg-muted/60 hover:border-border',
      )}
    >
      {icon}
      {label}
    </button>
  );
}

// ─── Step 2: Trainer ──────────────────────────────────────────────────────────

function TrainerStep() {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground leading-relaxed">
        Connect a smart trainer (FTMS) to receive real-time resistance from route gradients.
        Skip this and Demo Mode will simulate power for you.
      </p>
      <TrainerConnect />
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

        {openStep === 2 && (
          <div className="px-4 pb-4">
            <TrainerStep />
          </div>
        )}
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
