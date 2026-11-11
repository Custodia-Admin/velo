# Evidence: Chengdu Luxe Lakes world (P3.1a, card t_55f6c646, PR #97)

The first remote world. Bundle `worlds/chengdu-luxelakes/80e66bc0c3354d4b/`
on R2 (`velo-worlds`, public r2.dev). Figures and bake details are in
[WORLD-FORMAT.md § Chengdu Luxe Lakes](../../../../worlds/WORLD-FORMAT.md#chengdu-luxe-lakes),
and the procedure is in [ADDING-A-WORLD.md](../../../../worlds/ADDING-A-WORLD.md).

| Acceptance | Result |
| --- | --- |
| P1.3 gate | `standard`, registered **2.35 m ≤ 6.00 m, PASS** (1.09 m before `flatLakes`; 0.99 m over the 39 points more than 100 m from water; the two worst points lie on dug lakes the reference DEM still shows as land) |
| Bundle | 1.51 MB brotli (≤ 8 MB); deterministic: an `--out` bake and the committed bake are byte-identical for all 8 files |
| First ride downloads ≤ 8 MB | 1.75 MB (`e2e/remote-world.spec.ts`) |
| Offline after one ride | The second ride starts the world with the network offline. No world request reaches the network: the Cache API and the service worker (`velo-worlds-v1`) serve it, and the rider model is precached |
| Smoke ride token-free | Built with `VITE_CESIUM_ION_TOKEN=` empty: the only `eyJhbG` string is an input placeholder; no cesium.com traffic (`e2e/smoke-ride.spec.ts`, `e2e/remote-world.spec.ts`) |
| Ride shots | Both routes at 0.5 / 3 / 6 km, noon and golden hour, 1280×648@2 and 390×844 (`ride-*.jpg`). The rider is on the drawn road in every shot, and there are no voids. Under the rider there is one road strip, except at a junction (Luxe Lakes 0.5 km, where a residential road meets the tertiary one); 4.0 % / 7.7 % of route samples lie under two strips, against Perugia's 3.4–8.0 % and Lugano's 5.6–10.5 %. The parallel ribbons beside the road are separately mapped OSM ways (split carriageways, cycle tracks). No water within 28 m of the rider at any shot spot |
| fps ≥ 58, HUD on, medium | the test host's idle Intel iGPU (ANGLE gl-egl), final build: Xinglong and Luxe Lakes each **60 fps** (vsync cap) over 3 × 5 s rounds and a 60 s ride, 0 % of frames over 20 ms, rider in frame 100 %. The Perugia reference reads the same (`scripts/world-hud-fps.py`). The laptop was under load (~10) and its figures aren't used |
| Home | "Places we want to go" lists the two Chengdu world rides first, without the "Map view" pill. The rest of the wishlist now carries main's existing mixed-area pill and note (UI-RULES §7). No component code changed (`home-wishlist-*.jpg`, main vs PR at 1440; PR at 1280×648@2, 390 and TV) |

## Defects found and fixed while shooting

- **Xinglong loop ridden backwards.** The OSM relation lists its ways
  counter-clockwise although the loop is signed clockwise (顺时针), which put
  the lake on the rider's left. The route is now ridden reversed, and a
  shoelace pin in `scenicRouteData.test.ts` covers it.
- **Tilted lakes.** GLO-30 (flown 2011–15) predates the lakes dug in Tianfu,
  so Xinglong Lake's water was a sheet spanning 456–484 m. The bake step
  `flatLakes` now levels every lake and pond, and the renderer draws a level
  lake flat. Ground standing above a lake (a route crossing a lake arm) stays
  dry, and stream ribbons stay off the road where they pass under it.
- **A step where each loop closes.** Both loops stepped 2.4–3.1 m in their
  first 10 m (27–31 %), because the profile's two ends disagree. `closeLoop`
  ramps the target so a loop meets itself at one height. Perugia's Assisi loop
  has the same step and is named in the test until it is re-baked (card
  t_c57ea7c4).
