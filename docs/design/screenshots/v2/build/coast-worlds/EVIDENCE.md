# P3.1c coast worlds: evidence

Card t_4ee1b9d4 · PR #104. Three remote worlds on the P3.1a infrastructure: Berkeley / Bay Trail,
Santa Monica / Venice and Puerto Vallarta. Each ships its bundle as hashed files on R2. Only the
manifest is committed.

| Check | Result |
|---|---|
| Gate (P1.3 v2, GLO-30) | Berkeley: registered RMS **0.41 m**, PASS. Santa Monica: **0.55 m**, PASS. Puerto Vallarta: **0.84 m**, PASS. The bound is 6 m (bake log `validate (P1.3 v2)`). |
| Size (brotli / gzip as shipped) | Berkeley 0.79 / 1.01 MB. Santa Monica 3.80 / 4.83 MB. Puerto Vallarta 1.21 / 1.56 MB. All are ≤ 8 MB. |
| First ride ≤ 8 MB, second ride offline | Covered by `e2e/remote-world.spec.ts`, run in CI on every push (smoke-ride). For each world it rides from its Home card, counts the world bytes, then rides again with the browser offline and checks that no world request goes to the network. |
| Deterministic | Same machine (cat-bed, node 26): `bakedet.sh` bakes each world twice. All 24 files are byte-identical, and the bake reproduces the published manifests exactly. Across machines (laptop on node 24, cat-bed on node 26): every layer's content is identical except Santa Monica's and Puerto Vallarta's `roads.json`, where the route fit's float steps differ between V8 versions. Publish from cat-bed only. |
| Home | All three appear under "Places we want to go", ahead of the map rides, with world weather and no "Map view" badge. They ride the baked world by default, and photoreal stays opt-in. Each card of a place with two rides now names its route (`home-wishlist-1440.jpg`, `home-wishlist-390.jpg`). |
| Ride shots | `sheet-<route>-1280.jpg` holds 3 spots × noon and golden hour at 1280×648@2. `sheet-<route>-390.jpg` holds the same spots at 390×844@2. In every frame the rider is on the drawn road and there is no void. See the notes below. |
| fps | See below. |

## Routes

| World | Routes |
|---|---|
| Berkeley | `scenic-berkeley-bay-trail` (12.7 km), and new `scenic-richmond-marina-bay` (9.3 km, the Bay Trail round Richmond's Marina Bay). |
| Santa Monica / Venice | `scenic-santa-monica-strand` (22.9 km). It now starts on the beach path south of the pier: a start on the pier climbed its stairs and came back down. It ends on the Hermosa pier plaza. Also new `scenic-will-rogers-venice` (9.8 km), which passes the pier through the underpass. |
| Puerto Vallarta | `scenic-puerto-vallarta-malecon` (8.7 km). It now rides the Malecón itself, over the Puente del Malecón, where it used to take Calle Juárez a block inland. Also new `scenic-nuevo-vallarta-bucerias` (9.6 km), which ends on Bucerías' beachfront street. |

The route fit bends a few roads and adds **no join pieces** in any of the three worlds.

## Coast

- **Sea.** Sea polygons are built from OSM `natural=coastline` (`tools/worldbake/coast.mjs`, enabled by the recipe flag `"coast": true`). Nodes under the sea are set to 0 m.
- **Beaches.** `natural=beach` is sloped down to the water at 1:25. GLO-30 gives Santa Monica's beach as a shelf 4–7 m high, which hid the sea from the path.
- **Sand.** Beach and sand areas are drawn as sand, with a wet band at the waterline.
- **Sea shading.** The sea is blue, teal over the shallows, and hazes at half the land's rate.
- **Surf.** Surf breaks on open shores only, so marinas and channels just lap.
- **Horizon.** An apron carries the sea out to the far plane.
- **Water budget.** Water triangles stay inside the PR #44 budget, because the sea is tessellated at 3× the lattice edge (`waterMesh.test.ts` BUDGET).

### Notes on the shots

- **Santa Monica.** The beach is 100–200 m wide, so from the path the sea is a band along the horizon, as it is in life. **Open defect at spot 500:** the path crosses the Pico storm-drain lagoon on its bridge. OSM maps that lagoon as a 4-corner `water=pond` box, about 70 × 60 m. In chase view it reads as a flood across the path with a hard straight edge, not as a lagoon. The fix belongs in the bake: drop or reshape small ponds that a route crosses on a bridge in a coast world. Spots 11000 and 13000 read as beach with sea and surf.
- **Puerto Vallarta.** The Malecón and Paseo Díaz Ordaz interleave at Los Arcos (spot 600), so the drawn roads cross there as mapped. From spot 1100 on, the hotel zone puts hotels between the boulevard and the sea.
- **Nuevo Vallarta–Bucerías.** Resorts stand between the road and the beach, so the sea shows only on Bucerías' last kilometre.

## fps (cat-bed Intel iGPU, ANGLE gl-egl, HUD on, medium)

Other workers' fps runs share cat-bed's iGPU, and its qemu guests swing it: Perugia reads 19 fps at load 9. Every number here comes from a run where no other worker's driver was alive. The 1-minute load is given with each run.

| Route | Long ride (60 s) | Load |
|---|---|---|
| Berkeley Bay Trail | 60.0 fps, 0 % over 20 ms | 0.9 |
| Richmond Marina Bay | 60.0 fps, 0 % over 20 ms | 0.6 |
| Puerto Vallarta Malecón | 60.0 fps, 0 % over 20 ms | 0.6 |
| Nuevo Vallarta–Bucerías | 60.0 fps, 0 % over 20 ms | 1.0 |
| Perugia (reference) | 60.0 fps | 2.6 |

**Santa Monica** was the hard one, because of Los Angeles County's surveyed footprints: 121 k houses, 9.6 vertices each. Uncapped at the start of the Strand, buildings took it from 194 fps with buildings hidden to 41 fps with them shown (1.83 M triangles). Three fixes, each general and opt-in where it touches a bake:

1. **Footprint simplification.** The recipe sets `buildingSimplifyM: 1`, so SM footprints are simplified at 1 m: 1.16 M → 0.80 M footprint vertices.
2. **Far chunks as boxes.** Chunks beyond `buildingDetailM` (1.2 km at medium) draw each footprint as its box. Will Rogers went from 937 k to 573 k building triangles, and Lugano from 981 k to 744 k.
3. **Triangle cap.** Each tier caps building triangles, `buildingTris`: 0.8 M at medium, nearest chunks first. Lugano's start (0.74 M) fits under it.

Uncapped at the start, at load 1–3: the Strand went 41 → 77 fps, Will Rogers 65 → 82, and Lugano 60 → 68. These are from `catgroups.py`.

The capped HUD runs on the final build (`fps-cap8`) wait for an idle cat-bed (load < 1.5). Their results are appended below once they finish.

Scripts are in `~/.hermes/handoffs/velo/t_4ee1b9d4/`:

- `catfps_ab.sh`: capped HUD fps. A run is retried if another worker's driver overlapped it.
- `catgroups.py`: uncapped fps and triangles, with each group shown or hidden.
- `run_shots.sh`
- `home/home_wishlist.py`
