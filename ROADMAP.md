# Velo — Roadmap

Velo v2: the best riding app we can make, with real 3D that works with
**zero third-party tokens** and no new spend, published as open source with
upstream credit. Decision: [ADR-001](docs/architecture/ADR-001-rendering.md).
Packets, files and acceptance criteria:
[`VELO-V2-BLUEPRINT.md`](docs/architecture/VELO-V2-BLUEPRINT.md) §2.

Every UI packet goes through the design gate (`docs/design/UI-RULES.md` §0:
mockup → vision review → build → 1440/390 compare, plus TV 1920×1080 from
P1.5). Full suites run in GitHub CI.

## Phase 0 — Land the household build
- [x] P0.1 Merge the branch stack to main + ride-tonight residue (PR #7, 2,232 tests green)
- [ ] P0.2 ADR-001 rendering decision + brief and roadmap update *(in review)*

## Phase 1 — Foundations (after P0; P1.1, P1.2, P1.3, P1.5 in parallel)
- [ ] P1.1 Ride FSM: `idle → ready → riding ⇄ paused → finished`, × source, × trainer state; regression tests for the standstill, pause, disconnect and swap bugs
- [ ] P1.2 Renderer seam: `WorldRenderer` interface, pure `rideSim.step()`, Cesium moved behind the seam, `renderer: 'world' | 'photoreal'` (default `'world'`), Cesium chunk lazy
- [ ] P1.3 World bake v0, Perugia: `tools/worldbake/` (terrarium DEM + OSM Overpass + p2e routes), ≤ 8 MB, deterministic, credits
- [ ] P1.4 three.js renderer v0 (needs P1.2 + P1.3): terrain chunks, roads, stylized GLTF rider, chase cam, sky; token-free ride with no request to cesium.com
- [ ] P1.5 Visual identity v2, warm atlas: mockups for five screens at 1440/390/TV; Federico signs off before any P2 UI packet

## Phase 2 — Beautiful (after P1)
- [ ] P2.1 World materials, light, weather, time of day: water, trees, buildings, landmarks, live Open-Meteo
- [ ] P2.2 Lugano world + destination system (Home generated from manifests: Home · Perugia, Hometown · Lugano, Places we want to go)
- [ ] P2.3 Show & journey mode v2: local video overlay, Document PiP ride-over-anything, cinematic director
- [ ] P2.4 Visual identity v2 build (tokens + `src/components/velo/`, after P1.5 sign-off)
- [ ] P2.5 Device layer: battery, auto-reconnect, steering feel, handlebar button map

## Phase 3 — Destinations and play (after P2)
- [ ] P3.1 Wishlist worlds (Chengdu, Ohio & Erie towpath, Cleveland, Berkeley, Santa Monica, Puerto Vallarta) on Cloudflare R2, cached after the first ride
- [ ] P3.2 Play layer on the new renderer: postcards, riding buddy, couple ghost, collectibles
- [ ] P3.3 TV mode polish (`data-layout="tv"`, overscan, companion control)

## Phase 4 — Open source (after P2; docs can start earlier)
- [ ] P4.1 Repo hygiene and attribution: name, LICENSE (both copyright lines), NOTICE, README, CONTRIBUTING, CI, privacy scrub. Publish under `Custodia-Admin/velo` (owner decision, ADR-001)
- [ ] P4.2 Release v2.0.0: Cloudflare Pages, R2 worlds, fresh-clone check

Critical path: P0.1 → P1.2/P1.3 → P1.4 → P2.1 → P4.

## Already shipped in Velo (before v2)
- [x] Comfort defaults: 35 % hills feel, ERG off, no training asks on Home
- [x] Two-rider roster with per-rider settings
- [x] Easy & Scenic route library (near home, hometown, further, travels), real bike-routed geometry
- [x] Journey and show mode (local video over the ride, auto-cinematic camera)
- [x] Live weather (Open-Meteo) for sky, fog and rain, plus wind through FTMS SIM
- [x] Zwift Ride handlebar controllers: steering, virtual gears, pause, camera
- [x] Play mode spike: postcards and a riding buddy
- [x] Trainer reconnect after reload; token-free ride fallback with upgrade banner

---

## Before the fork — GlobeRide roadmap (upstream, © Mason Wyatt)

Kept as upstream wrote it; this is the work Velo builds on.

> Goal: make GlobeRide a genuinely elite virtual-cycling product — top-tier
> graphics, 3D assets, photorealistic maps, deep workouts, best-in-class UI/UX.
>
> Driven by `/loop`: each iteration advances the next unchecked wave —
> parallel sub-agents → integrate → typecheck + build → verify → commit/push
> (auto-deploys to globeride.vercel.app).

### Done
- [x] Vercel deploy — edge proxies, PWA, env
- [x] Cinematic eased camera, scene polish (FXAA/MSAA/shadows, golden-hour light)
- [x] Photorealistic 3D-tile maps; route clamped to the real surface
- [x] Procedural animated rider avatar (pedalling legs, lean, spin)
- [x] Route looping when a workout outlasts the map
- [x] Elite landing page; local-first profile + XP + gear garage
- [x] Categorized workout picker

### Wave 1 — UX depth + finish open items  ✅
- [x] StravaConnect component + hardened Strava lib (component built; lib in use)
- [x] Ride history — rich history view: per-ride detail, stats, trends
- [x] In-ride HUD/UX overhaul — refined metrics, workout panel, ride controls
- [x] Workout depth — 31-workout catalog + 6 multi-week training plans

### Wave 2 — Graphics & 3D assets  ✅
- [x] Route line gradient-coloured by steepness; distance + start/finish markers
- [x] Avatar polish — 45-part procedural cyclist (drivetrain, cockpit, hands)
- [x] 2D minimap overlay on the ride screen
- [x] Weather + time-of-day scene moods

### Wave 3 — Maps & worlds  ✅
- [x] 10 curated iconic climbs bundled in-app (Alpe d'Huez, Ventoux, Stelvio…)
- [x] Rich pre-ride route preview — gradient zones, climb categorisation, difficulty
- [x] Local-first segment leaderboards — personal records on route climbs

### Wave 4 — Cohesion & performance  ✅
- [x] First-run onboarding flow + motion-design micro-interactions
- [x] Mobile / tablet responsiveness pass
- [x] Graphics-quality tiers (low / medium / high) for the 3D globe

### Wave 5 — Immersion & life  ✅
- [x] Ghost riders — race past attempts as translucent ghost avatars
- [x] Ride audio — synthesised ambient soundscape, effort cues, chimes
- [x] Achievements & badges — 25 milestones tied to the rider profile

### Wave 6 — Hardening & cohesion  ✅
- [x] Correctness pass — bug hunt + fixes across the ride + setup experiences
- [x] Visual cohesion pass — consistency of spacing / type / states

### Wave 7 — Cinematic & analytical  ✅
- [x] Cinematic 3D rendering — bloom, ambient occlusion, vignette/grade, richer atmosphere
- [x] Post-ride analytics — power curve, time-in-zones, per-km splits
- [x] Expanded content — 19 iconic routes total + ~44 curated workouts

### Wave 8 — Refinement  ✅
- [x] Home reorganised into clean Ride / Routes / Workouts / History tabs
- [x] Deep QA pass — fixed 4 real bugs (sample mutation, viewer guards, PR race, timer leak)

### Wave 9 — Final production polish  ✅
- [x] Empty / loading / error states + accessibility across every screen
- [x] Micro-interactions + final cross-screen visual cohesion

### Wave 10 — Real 3D avatar & gear  ✅
- [x] Authored 3 glTF models (road / gravel / TT cyclist) — PBR materials,
      animatable nodes — via a from-scratch glTF generator, bundled + precached
- [x] glTF rendering integrated into the avatar system — node animation,
      procedural avatar kept as the offline fallback
- [x] Garage 2.0 — selectable bike models + colourways

### Wave 11 — Deeper training platform  ✅
- [x] Fitness / Form — CTL / ATL / TSB Performance Management Chart
- [x] Training-plan progression — calendar view with streaks + today/next-up
- [x] Personal records board + weekly/monthly trend charts

### Wave 12 — Code health & repo hygiene  ✅
- [x] Fixed the failing vitest (preset-workout duration window) — 269/269 pass
- [x] Deleted `StravaConnect.tsx` (430 lines of confirmed dead code)
- [x] ESLint 9 flat config + `npm run lint` — 0 errors
- [x] README rewritten to reflect the current product
- [x] DRY extraction — shared `SectionHeader`/`Section`, consolidated `format.ts`, `useRideHistory` hook
- [x] 47 flat components reorganised into 7 domain folders (`ride/setup/workouts/training/routes/profile/trainer`)

### Hardware-gated (needs the user's trainer)
- [ ] Cadence — confirm FTMS flags from the Kickr; add a Cycling Power fallback
