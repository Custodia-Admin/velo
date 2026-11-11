# P3.1c coast worlds: evidence

Card t_4ee1b9d4 · PR #104. Three remote worlds on the P3.1a infrastructure: Berkeley / Bay Trail,
Santa Monica / Venice and Puerto Vallarta. Each ships its bundle as hashed files on R2. Only the
manifest is committed.

| Check | Result |
|---|---|
| Bundles (R2) | `berkeley/7a3a25f44a1d86e7`, `santa-monica-venice/155c646e205b51fd`, `puerto-vallarta/9d190b96b345ea2b`. Each superseded bundle has been deleted from R2 (it now returns 404). |
| Gate (P1.3 v2, GLO-30) | Berkeley: registered RMS **0.41 m**, PASS. Santa Monica: **0.55 m**, PASS. Puerto Vallarta: **0.84 m**, PASS. The bound is 6 m (bake log `validate (P1.3 v2)`). |
| Size (brotli / gzip as shipped) | Berkeley 0.79 / 1.01 MB. Santa Monica 3.80 / 4.83 MB. Puerto Vallarta 1.21 / 1.56 MB. All are ≤ 8 MB. |
| First ride ≤ 8 MB, second ride offline | Covered by `e2e/remote-world.spec.ts`, which runs in CI on every push (smoke-ride). For each world it rides from the Home card and counts the world bytes. It then rides again with the browser offline and checks that no world request reaches the network. |
| Deterministic | All on the bake host (node 26). Each final bake was run twice to `--out`, then once for real: Santa Monica and Puerto Vallarta gave all 8 files identical, and the real bake matched. Berkeley is unchanged since its last same-host run, where all 24 files (three worlds) matched. The pond fix re-bakes Berkeley, Perugia, Lugano and Chengdu byte-identical to their committed bundles. Across machines (node 24 vs node 26), every layer's content matches except `roads.json` for Santa Monica and Puerto Vallarta, because the route fit's float steps differ between V8 versions. Publish from the bake host only. |
| Home | All three worlds appear under "Places we want to go", ahead of the map rides, with world weather and no "Map view" badge. Each rides the baked world by default; photoreal stays opt-in. On a place with two rides, each card names its route (`home-wishlist-1440.jpg`, `home-wishlist-390.jpg`). |
| Ride shots | Taken on the final build. `sheet-<route>-1280.jpg` holds 3 spots × noon and golden hour at 1280×648@2; `sheet-<route>-390.jpg` holds the same spots at 390×844@2. All 72 frames: the rider is on the drawn road, there is no void, and no label overlaps. See the notes below. |
| fps (≥ 58, HUD on, medium) | Every coast route: **59.9–60.0**. See below. |

## Routes

| World | Routes |
|---|---|
| Berkeley | `scenic-berkeley-bay-trail` (12.7 km). New: `scenic-richmond-marina-bay` (9.3 km), the Bay Trail around Richmond's Marina Bay. |
| Santa Monica / Venice | `scenic-santa-monica-strand` (22.9 km) now starts on the beach path south of the pier, because a start on the pier climbed its stairs and came back down. It ends on the Hermosa pier plaza. New: `scenic-will-rogers-venice` (9.8 km), which passes the pier through the underpass. |
| Puerto Vallarta | `scenic-puerto-vallarta-malecon` (8.7 km) now rides the Malecón itself, over the Puente del Malecón. Before, it took Calle Juárez a block inland. New: `scenic-nuevo-vallarta-bucerias` (9.6 km), which ends on Bucerías' beachfront street. |

The route fit bends a few roads and adds **no join pieces** in any of the three worlds.

## Coast

- **Sea.** Sea polygons come from OSM `natural=coastline` (`tools/worldbake/coast.mjs`, turned on by the recipe flag `"coast": true`). Nodes under the sea are set to 0 m.
- **Beaches.** `natural=beach` slopes down to the water at 1:25. GLO-30 gives Santa Monica's beach as a shelf 4–7 m high, which hid the sea from the path.
- **Sand.** Beach and sand areas draw as sand, with a wet band at the waterline. Streams run under the sand in the landcover texture. Otherwise the 2.5 m Pico outlet, stroked at ~5 m texels, smeared grey-blue across the Strand. The water ribbon still draws the stream.
- **Route-dry water (all worlds).** The bake drops small ponds and lagoons that a route runs through or brushes: lakes and ponds only, under 1 ha, within the building clearance. In a coast world, a dried lagoon that touches the beach becomes beach, because OSM cuts it out of the sand and the default green would otherwise show through. In Santa Monica this dries the Pico storm-drain pond (Strand spot 500, Will Rogers 5510) and Santa Monica Lagoon (Will Rogers 1790). In Puerto Vallarta it dries a 28 m² pool beside the Malecón. Inland worlds bake byte-identical. Before and after: `sm500-pond-before-after.jpg`.
- **Sea shading.** The sea is blue, teal over the shallows, and hazes at half the land's rate.
- **Surf.** Surf breaks on open shores only, so marinas and channels just lap.
- **Horizon.** An apron carries the sea out to the far plane.
- **Water budget.** Water triangles stay inside the PR #44 budget, because the sea is tessellated at 3× the lattice edge (`waterMesh.test.ts` BUDGET).

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
| Berkeley Bay Trail, Richmond Marina Bay, Puerto Vallarta Malecón, Nuevo Vallarta–Bucerías | 60.0 each, 0 % over 20 ms, 60 s rides at load 0.6–1.0. Measured on the building-cap build (`fps-final1.out`). Every later change only removes building work: far boxes, the 0.8 M cap, the far-box material. | — |

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
- `home_wishlist.py`: the Home shots.
