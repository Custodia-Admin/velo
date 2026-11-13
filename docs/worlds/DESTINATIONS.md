# Destination manifests (velo-destination v1)

A **destination** is a place Home offers: its scenic routes, the 3D world that
draws them (when one is baked), the moods that suit it, its headline places
and the data credits, all in one manifest. Home is generated from these
manifests; no component lists places or routes. Adding a place means adding
a manifest.

| Piece | File |
| --- | --- |
| Manifests, one per place | `src/lib/world/destinations/<id>.json` |
| Types, validator, Home sections | `src/lib/world/destinations.ts` |
| World catalog (which routes the world renderer draws) | `src/lib/world/catalog.ts`, derived from the manifests |
| World-derived fields, copied from a bake | `tools/worldbake/syncDestinations.mjs` (`bake.mjs` runs it) |
| Home | `src/components/velo/ScenicHome.tsx` |
| Tests | `destinations.test.ts`, `src/components/velo/ScenicHome.test.ts` |

## Roles and Home

`role` places the destination on Home:

| Role | Home section |
| --- | --- |
| `home` | one section per destination, first: "Perugia" |
| `hometown` | one section per destination, next: "Lugano" |
| `wishlist` | one section for all of them: "Places we want to go", ordered by `order`; its tiles lead with the place name |

`home` and `hometown` are the featured worlds. The public build titles their
sections with the place name only. A private deploy can label them
"Home · Perugia" and "Hometown · Lugano" by building with
`VITE_HOUSEHOLD_LABELS=1` (`homeSections` in `src/lib/world/destinations.ts`;
[ADR-002](../architecture/ADR-002-publishing.md)). Put it in
`.env.production.local` (and `.env.development.local` for the dev server):
`vitest` runs in mode `test`, reads neither file, and so keeps testing the
public titles.

Today's ride sits above the sections and is skipped in its own section.
Inside a section, routes drawn by a 3D world come first. A route no world
draws carries a "Classic view" tag on its tile, and the section line never
says it. Since the wishlist worlds (13 Nov 2026) every place has a world, so
no shipped tile carries the tag; a new place without one would.

## Fields

| Field | Meaning |
| --- | --- |
| `format`, `version` | `"velo-destination"`, `1`. Another version fails with `unsupported`. |
| `id` | `[a-z0-9-]+`, equal to the file name. For a place that will get a world, use the world id it will have (`tools/worldbake/worlds/<id>.json`). |
| `name` | Place name: the section title on Home, the tile title in the wishlist, the "Today's ride · …" kicker. |
| `role`, `order` | See above. `order` sorts within a role. |
| `place` | Region and country, e.g. "Ticino, Switzerland". |
| `detail` | One line beside the section title. |
| `world` | `null`, or `{ id, dir, bbox, routes }` mirrored from the bundle's `manifest.json` (`dir` = `"<id>/"`, `routes` = the scenic routes snapped into it). |
| `extraWorlds` | Optional, only with a `world`: more worlds, each `{ id, dir, host?, bbox, routes }` like `world`, for the place's routes too far out for its main world (Lugano: Valle Maggia, the Magadino plain, Lake Varese and Lake Como; Perugia: Lake Trasimeno). A route is drawn by one world only. The catalog gets one entry per world; Home keeps one section per place. Moods and headline places stay the main world's; the extra worlds' credits are added after the main world's, once per credit. |
| `routes` | Scenic route ids (`src/lib/scenicRoutes.ts`) in display order. Every scenic route belongs to exactly one destination. Routes outside the world ride on the map. |
| `moods`, `defaultMood` | With a world: the world's. Without: the routes' own moods. |
| `pois` | `{ name, kind, lat, lon }`. With a world: its towns (POI rank 3), at most 8. Without: empty until the place is baked. |
| `credits` | `{ id, name, licence, url, attribution }`. With a world: the bundle's credits. Without: the route data's (OpenStreetMap, OSRM, Copernicus GLO-90 via Open-Meteo). One text per credit id across all manifests. |

`validateDestination()` throws a typed `DestinationError` (`invalid`,
`unsupported`, `duplicate`); `loadDestinations()` also rejects duplicate ids,
a world linked twice and a route listed twice.

## A destination without a world

It shows on Home with a map plate of its route and rides on the map
(the photoreal renderer; without a Cesium ion token, the OpenStreetMap map).
Nothing about it is a dead end. When its world is baked (P3.1):

1. set the manifest's `world` to `{ "id": "<id>" }`;
2. write `tools/worldbake/worlds/<id>.json` and bake it
   ([ADDING-A-WORLD.md](ADDING-A-WORLD.md)). A bake that writes to its default
   place runs `syncDestinations.mjs`, which copies the bbox, routes, moods,
   towns and credits from the bundle and sets `dir`: `<id>/` for a world in
   `public/worlds/`, `<id>/<hash>/` plus `"host": "remote"` for a world
   published to R2 (`"host": "remote"` in the recipe). Run
   `node tools/worldbake/syncDestinations.mjs` yourself after copying a bundle
   in by hand.

`destinations.test.ts` fails while a manifest is out of step with its bundle,
when a shipped world has no destination, or when a route has no destination.

## A place wider than one world

A world is at most 2048 nodes a side and 8 MB brotli, so a place whose routes
spread over 50 km (Lugano's reach up the Maggia valley and over to Lake Como)
gets more than one world. Bake each outlying world as its own remote world,
with its own recipe, and add `{ "id": "<world id>" }` to the destination's
`extraWorlds`; `syncDestinations.mjs` fills in the rest from the bundle, as it
does for `world`. The routes stay in the place's Home section, each ridden in
the world that draws it.

## Adding a hometown or a wishlist place

Write the manifest. A new `hometown` manifest becomes its own Home section, a
new `wishlist` manifest a tile in "Places we want to go". Its routes must
already exist in `src/lib/scenicRoutes.ts` (generated by
`scripts/build-scenic-routes.mjs`; never do a full rebuild just to add one).
