# P3.1c coast worlds: evidence

Card t_4ee1b9d4 · PR #104, reworked in t_0e7761c7 (Berkeley baked with bridges as structures, after
merging main with PR #103). Three remote worlds on the P3.1a infrastructure: Berkeley / Bay Trail,
Santa Monica / Venice and Puerto Vallarta. Each ships its bundle as hashed files on R2. Only the
manifest is committed.

| Check | Result |
|---|---|
| Bundles (R2) | `berkeley/99108f58c9ff2ad7` (with `bridges.json`), `santa-monica-venice/155c646e205b51fd`, `puerto-vallarta/9d190b96b345ea2b`. Each superseded bundle has been deleted from R2 (it now returns 404), Berkeley's `7a3a25f44a1d86e7` and the interim `27706f86319b7715` included. |
| Gate (P1.3 v2, GLO-30) | Berkeley: registered RMS **0.41 m**, PASS. Santa Monica: **0.55 m**, PASS. Puerto Vallarta: **0.84 m**, PASS. The bound is 6 m (bake log `validate (P1.3 v2)`). |
| Size (brotli / gzip as shipped) | Berkeley 0.79 / 1.02 MB. Santa Monica 3.80 / 4.83 MB. Puerto Vallarta 1.21 / 1.56 MB. All are ≤ 8 MB. |
| First ride ≤ 8 MB, second ride offline | Covered by `e2e/remote-world.spec.ts`, which runs in CI on every push (smoke-ride). For each world it rides from the Home card and counts the world bytes. It then rides again with the browser offline and checks that no world request reaches the network. |
| Deterministic | All on the bake host (node 26). From the merged tree (main with PR #103 and #110), Berkeley's real bake and an `--out` re-bake give all 9 files identical. Santa Monica, Puerto Vallarta, Cleveland and Cuyahoga Valley (both on bare ground), and Chengdu re-bake to manifests byte-identical to the committed ones, so they keep their bundles; Perugia and Lugano re-bake byte-identical to their committed bundles. Across machines (node 24 vs node 26), every layer's content matches except `roads.json` for Santa Monica and Puerto Vallarta, because the route fit's float steps differ between V8 versions. Publish from the bake host only. |
| Home | All three worlds appear under "Places we want to go", ahead of the map rides, with world weather and no "Map view" badge. Each rides the baked world by default; photoreal stays opt-in. On a place with two rides, each card names its route (`home-wishlist-1440.jpg`, `home-wishlist-390.jpg`). |
| Ride shots | Taken on the final build (Berkeley Bay Trail and Richmond Marina Bay re-shot on the bridges build, at the same places). `sheet-<route>-1280.jpg` holds 3 spots × noon and golden hour at 1280×648@2; `sheet-<route>-390.jpg` holds the same spots at 390×844@2. All 72 frames: the rider is on the drawn road, there is no void, and no label overlaps. See the notes below. |
| fps (≥ 58, HUD on, medium) | Every coast route: **59.9–60.0**. Berkeley with bridges: **60.0** on both routes. See below. |
| Bridges (Berkeley) | No deck the route doesn't ride stands within −0.3…+4.5 m of the rider's surface; the rider shows in full under the I-580 deck. See "Bridges" below and `berkeley-bridges-before-after-1280.jpg` / `-390.jpg`. |

## Routes

| World | Routes |
|---|---|
| Berkeley | `scenic-berkeley-bay-trail` (12.6 km). At Albany it crosses Buchanan Street on its bridge and comes down the Eastshore Highway ramp (see "Bridges"). New: `scenic-richmond-marina-bay` (9.3 km), the Bay Trail around Richmond's Marina Bay. |
| Santa Monica / Venice | `scenic-santa-monica-strand` (22.9 km) now starts on the beach path south of the pier, because a start on the pier climbed its stairs and came back down. It ends on the Hermosa pier plaza. New: `scenic-will-rogers-venice` (9.8 km), which passes the pier through the underpass. |
| Puerto Vallarta | `scenic-puerto-vallarta-malecon` (8.7 km) now rides the Malecón itself, over the Puente del Malecón. Before, it took Calle Juárez a block inland. New: `scenic-nuevo-vallarta-bucerias` (9.6 km), which ends on Bucerías' beachfront street. |

The route fit bends a few roads and adds **no join pieces** in any of the three worlds.

## Coast

- **Sea.** Sea polygons come from OSM `natural=coastline` (`tools/worldbake/coast.mjs`, turned on by the recipe flag `"coast": true`). Nodes under the sea are set to 0 m.
- **Beaches.** `natural=beach` slopes down to the water at 1:25. GLO-30 gives Santa Monica's beach as a shelf 4–7 m high, which hid the sea from the path.
- **Sand.** Beach and sand areas draw as sand, with a wet band at the waterline. Streams run under the sand in the landcover texture. Otherwise the 2.5 m Pico outlet, stroked at ~5 m texels, smeared grey-blue across the Strand. The water ribbon still draws the stream.
- **Route-dry water (all worlds).** The bake drops small ponds and lagoons that a route runs through or brushes: lakes and ponds only, under 1 ha, within the building clearance. In a coast world, a dried lagoon that touches the beach becomes beach, because OSM cuts it out of the sand and the default green would otherwise show through. In Santa Monica this dries the Pico storm-drain pond (Strand spot 500, Will Rogers 5510) and Santa Monica Lagoon (Will Rogers 1790). In Puerto Vallarta it dries a 28 m² pool beside the Malecón. Inland worlds bake byte-identical. A channel stays: water less round than 0.2 (4πA/P², 1 for a disc) is never dried, because a towpath runs beside its canal. The Cuyahoga towpath passes 1.7 m from the watered Ohio & Erie Canal at 7.95 km (450 × 19 m, mapped as plain `natural=water`, roundness 0.11). Everything dried above is 0.38 or rounder. Before and after: `sm500-pond-before-after.jpg`.
- **Sea shading.** The sea is blue, teal over the shallows, and hazes at half the land's rate.
- **Surf.** Surf breaks on open shores only, so marinas and channels just lap.
- **Horizon.** An apron carries the sea out to the far plane.
- **Water budget.** Water triangles stay inside the PR #44 budget, because the sea is tessellated at 3× the lattice edge (`waterMesh.test.ts` BUDGET).

## Bridges (Berkeley)

The recipe sets `"bridges": true`, so Berkeley bakes its bridges as structures (PR #103): 73 decks (7 ridden), 10 headroom pins, 4 abutments on approach ramps (landed on the uncarved ground, PR #110), 66 piers. Before, the renderer drew every bridge as a flat ribbon between its end heights. The John T. Knox Freeway (I-580) deck, 278 m long, lay on the Bay Trail beneath it and buried the rider on both routes.

**Decks over the rider.** Measured against the app's own surfaces (decks from `bridges.json` via `deckTopAt`, the rider's surface from `routeSurface`), walking each route every metre within each deck's half-width. Berkeley now has no straight-span bridge. No deck the route doesn't ride stands within −0.3…+4.5 m of the rider's surface (the review measured the flat ribbon at −0.5…+0.4 m).

| Deck over the route | Deck top over the rider | Underside over the rider |
|---|---|---|
| I-580, Berkeley shoreline 2489–2701 m and Richmond 625–704 m | 5.1–6.9 m (was −0.5…+0.4 m) | ≥ 4.4 m where the trail runs beneath it; 3.3–3.5 m at its low end, where the trail enters or leaves its edge 3–6 m off the centreline (Berkeley 2489–2495 m, Richmond 701–704 m) |
| Eastshore Freeway and the I-580 interchange, 2703–2771 m and 3910–3942 m | 6.2–8.1 m (was 3.9–8.8 m) | 4.4–6.2 m |

PR #103's headroom rule (4.5 m, 0.15 m tolerance) is checked where a route crosses a deck's centreline, and every crossing passes. The 3.3 m edge passes cross no centreline. The camera rides 2.6 m over the rider, so it stays under the slab there, and the rider shows in full (`2493` below).

**Rider visible.** Token-free production build, 1280×648@2 and 390×844@2, standard chase camera, noon. The rider is painted flat magenta, and its pixels are counted with the roads and bridges drawn against both hidden; a deck's shadow on the rider then doesn't change the count. Before is the reviewed head (dd13ef7), after is this build. The Berkeley shoreline from 2633 m is re-routed (below), so 3966 m before is the same place as 3915 m after.

| Spot | Before 1280 / 390 | After 1280 / 390 |
|---|---|---|
| Berkeley shoreline 2520 | 48 % / 49 % | 102 % / 101 % |
| Berkeley shoreline 2560 | 9 % / 9 % | 101 % / 102 % |
| Berkeley shoreline 2620 | 100 % / 101 % | 101 % / 101 % |
| Berkeley shoreline 2493 (deck edge) | 100 % / 99 % | 101 % / 100 % |
| Berkeley shoreline 3966 → 3915 (Eastshore) | 101 % / 102 % | 102 % / 102 % |
| Berkeley shoreline 2700, 2900 (Buchanan deck), 3000 (new line) | — | 101–102 % |
| Richmond 640 | 13 % / 13 % | 101 % / 101 % |
| Richmond 676 | 38 % / 38 % | 101 % / 102 % |
| Richmond 702 (deck edge), 1620, 1645 (controls) | 100–102 % | 101–103 % |

In the after frames, the grey slab over the rider at 2520, 2560, 640 and 676 is the underside of the I-580 deck, which the trail runs beneath. At every spot after, the rider stands 0.00–0.26 m over the heightfield (0.07 m on the Buchanan Street deck, which the DEM reads at deck height), and the camera stays 2.60 m over the rider. Under the I-580 deck the terrain hides stretches of the Bay Trail's drawn path ahead of the rider (Richmond 640, Berkeley 2520). The trail and the ground there are the same as before the re-bake: the trail piece is byte-identical, and the heightfield moves by at most 0.24 m. The flat motorway ribbon used to cover that ground. The route guide stays visible.

**Buchanan Street.** With bridges on, the Albany interchange could not bake. The trail's link ran under the Buchanan Street bridge 15 m from the top of the Eastshore Highway ramp, and 4.5 m of headroom there needs a ramp landing on the trail itself. PR #103 refuses that (approach onto a ridden road). A waypoint on the ramp now takes the route from the end of the Bay Trail at the Buchanan signal over the bridge and down the ramp to Eastshore Highway. It rides that deck (2854–2938 m) and is otherwise unchanged before 2633 m and after 3061 m (3112 m before). It is regenerated with `ONLY=`, and every other route is byte-identical.

**Deck ends.** The bridges step's decimetre rounding turned one deck end (Marina Bay Trail, road 1350) a fraction of a degree, which took 2 m of Richmond's painted guide 0.01–0.18 m off the drawn roads at 1,645 m. The bake grows such a free end along its own end segment until the guide is covered, at most 1 m (here 0.1 m), and then checks the paint again.

**fps** (the test host's iGPU, HUD on, medium, two rounds interleaved with the Perugia control, final build): Berkeley Bay Trail **60.0** and Richmond Marina Bay **60.0** in both rounds, 0 % of frames over 20 ms. Perugia read 60.0 alongside, at 1-minute load 0.6–2.1. An earlier run, made while other VMs loaded the host (load 7–11), read Perugia 20.6–21.6 and the Berkeley routes 20.0–26.6, so they tracked the control there too.

### Notes on the shots

- **Santa Monica.** The beach is 100–200 m wide, so from the path the sea is a band along the horizon, as it is in life. Spot 500 is the old pond, which now reads as beach. Spots 11000 and 13000 read as beach with sea and surf.
- **Will Rogers–Venice.** Spot 1790 is the dried Santa Monica Lagoon and spot 5510 the Pico channel. Both read as sand.
- **Puerto Vallarta.** The Malecón and Paseo Díaz Ordaz interleave at Los Arcos (spot 600), so the drawn roads cross there as mapped. From spot 1100 on, the hotel zone puts hotels between the boulevard and the sea.
- **Nuevo Vallarta–Bucerías.** Resorts stand between the road and the beach, so the sea shows only on Bucerías' last kilometre.
- **Golden hour on the bay and the Pacific.** These coasts face west, so a low sun over the water blooms the left of some frames (Richmond 4000, Bucerías 9450). That is the sun, not a fault.

## fps (the test host's Intel iGPU, ANGLE gl-egl, HUD on, medium, vsync)

Other fps runs share the test host's iGPU, and other VMs on the host swing its CPU: Perugia on main reads 20 fps at load 8. Every number here comes from a run where no other fps or shot driver was alive. The runs are interleaved with main (ce60b13, `index-C7f2mmhH.js`) on the same box. Runs from load spikes (1-minute load 6–10, where main dropped too) are left out. Each figure is the long ride from the route start: 30 s, or 60 s where noted.

| Route | Final build | main ce60b13 |
|---|---|---|
| Santa Monica Strand | **60.0** (load 1.1). The build before the far-box material read 59.9, 60.0 and 60.0. | — |
| Will Rogers–Venice | **59.9**, 59.9, 0.1 % of frames over 20 ms (load 0.8, 0.6). The build before the far-box material read 55.9 and 56.1. | — |
| Perugia (control) | 60.0 in every uncontended pair (4) | 60.0 in the same pairs |
| Lugano Melide (control) | 51.4, 53.1 | 49.9, 50.5 |
| Berkeley Bay Trail, Richmond Marina Bay | **60.0** each, 0 % over 20 ms (load 1.3, 1.7; the Perugia control just before read 60.0). The building-cap build gave the same over 60 s rides. | — |
| Puerto Vallarta Malecón, Nuevo Vallarta–Bucerías | 60.0 each, 0 % over 20 ms, 60 s rides at load 0.6–1.0, on the building-cap build (`fps-final1.out`). Every later change only removes building work: far boxes, the 0.8 M cap, the far-box material. A final-build rerun hit a CPU load burst from other VMs (the Perugia control fell to 41.8), so it is left out. | — |

Lugano is not one of these worlds. It is listed because it shows the far-box changes don't cost an inland world anything: main reads under 58 on this iGPU, and the branch reads a little better.

**Why Santa Monica was hard.** Los Angeles County surveys its footprints: 121 k houses at 9.6 vertices each. Uncapped at the start of the Strand, buildings took the scene from 194 fps (buildings hidden) to 41 fps (1.83 M triangles). Four fixes, each general:

1. **Footprint simplification.** The recipe sets `buildingSimplifyM: 1`, so Santa Monica's footprints are simplified at 1 m: 1.16 M → 0.80 M footprint vertices.
2. **Far chunks as boxes.** Chunks beyond `buildingDetailM` (1.2 km at medium) draw each footprint as its box.
3. **Triangle cap.** Each tier caps building triangles with `buildingTris`: 0.8 M at medium, nearest chunks first.
4. **Plain far-box material.** Far boxes use a plain material: vertex colours, light and atmosphere, no wall or roof detail, no shadows (`createFarBuildingMaterial`). At Will Rogers' start, 0.51 M box triangles past 3 km were shaded with the full wall shader. That was 6.8 ms of a 12 ms frame, while hiding the boxes nearest the camera made no difference. Uncapped, the plain material takes that frame from 83 to 104 fps, and capped from 56.0–56.1 to 59.9. At a box's distance the wall detail has already faded to its mean. Will Rogers 300 and 1000, noon, before against after: 0.1–0.2 % of pixels differ, and those are the rider's pedal stroke, cloud drift and a HUD digit.

The uncapped breakdowns come from `catgroups_probe.py`, which hides a group, or the boxes, near or far chunks, and swaps materials, interleaved in one session.

The probe scripts are kept outside the repo:

- `catfps_final.sh`: capped HUD fps (`scripts/world-hud-fps.py`), interleaved with main. A run is retried if another fps or shot driver overlapped it.
- `catgroups_probe.py`: uncapped fps by group, box/detail/distance and material.
- `run_shots_final2.sh` (`scripts/route-clearance-shots.py`) and `make_sheets.py`: ride shots and sheets.
- `home_wishlist.py`: the Home shots. They were re-shot on the bridges build (`home_shots.py`): each card of a two-ride place names its route.
- `ridervis3.py`, `compose.py`: the magenta rider counts and the before/after composites. `probe6.scratch.test.ts`: the deck-over-rider walk on the app's own surfaces.
