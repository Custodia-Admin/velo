# Notice

Velo is free software under the [MIT licence](LICENSE).

## Upstream

Velo is a fork of **[GlobeRide](https://github.com/masonwyatt23/globeride)** by
Mason Wyatt, released under the MIT licence (Copyright (c) 2026 Mason Wyatt).
GlobeRide built the foundation Velo still rides on: the Web Bluetooth FTMS
trainer client, GPX parsing, the cycling physics, FIT export, the Cesium globe
and the pace partners. Its copyright line is kept in [LICENSE](LICENSE) next to
Velo's, and the app credits it under Settings → About.

## Data

The app code is MIT. The world bundles (`public/worlds/<id>/` and the remote
bundles listed in `tools/worldbake/remote/`) are **data**, and each carries the
licences of the sources it was baked from. Full source list, licences,
modifications and the exact inputs of every world:
[docs/worlds/CREDITS.md](docs/worlds/CREDITS.md).

- **OpenStreetMap.** Roads, water, land cover, buildings, places and the
  scenic route geometry. © OpenStreetMap contributors. The vector layers of
  every bundle are a Derivative Database of OpenStreetMap, published under the
  [Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1-0/).
  Contains information from OpenStreetMap, which is made available here under
  the Open Database License (ODbL).
- **Copernicus DEM GLO-30 Public** (heightfields of worlds baked with
  `"dem": { "source": "copernicus-glo30" }`, e.g. Lugano). Produced using
  Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space
  GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all
  rights reserved. As Art. 6 of the GLO-30 licence requires of anyone who
  distributes the data: The organisations in charge of the Copernicus
  programme by law or by delegation do not incur any liability for any use of
  the Copernicus WorldDEM-30. Neither the Copernicus programme nor Airbus
  endorses Velo.
- **USGS 3D Elevation Program (3DEP)** 1/3 arc-second DEM (bare ground along
  the routes of the Cuyahoga Valley, Cleveland and Santa Monica worlds).
  Public domain; credit: U.S. Geological Survey, 3D Elevation Program 1/3
  arc-second Digital Elevation Model.
- **swissALTI3D** (bare ground along the routes of the Lugano world). Open
  Government Data of the Swiss Confederation. Source: Federal Office of
  Topography swisstopo.
- **Terrain Tiles** (Tilezen/Mapzen "terrarium" elevation on the AWS Open
  Data Registry; heightfields of the other worlds). Mixed open sources with
  attribution required; the full attribution list is in
  [docs/worlds/CREDITS.md](docs/worlds/CREDITS.md) and at
  <https://github.com/tilezen/joerd/blob/master/docs/attribution.md>.
- **Open-Meteo.** Live weather in the app (forecast API) and the scenic
  routes' elevation profiles (elevation API, Copernicus DEM GLO-90). Weather
  and elevation data by [Open-Meteo.com](https://open-meteo.com), under
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Copernicus DEM
  GLO-90 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018
  provided under COPERNICUS by the European Union and ESA; all rights
  reserved.
- **OSRM** bike routing on [routing.openstreetmap.de](https://routing.openstreetmap.de/about.html)
  (FOSSGIS e.V.), used once at build time to compute the scenic routes, which
  are derived from OpenStreetMap (ODbL, © OpenStreetMap contributors). The app
  never calls a routing server.

## Optional services

- **Cesium ion** and the imagery and 3D tiles it serves (including Google
  Photorealistic 3D Tiles) load only when you add your own Cesium ion token.
  Their own terms apply. Without a token, routes outside a baked world use
  OpenStreetMap's standard tiles (© OpenStreetMap contributors, subject to the
  [OSM tile usage policy](https://operations.osmfoundation.org/policies/tiles/)).

## Software

Velo bundles open-source packages, each under its own licence (for example
CesiumJS under Apache 2.0; three.js, React and Zustand under MIT). See
`package.json` and each package's licence in `node_modules`.

## Trademarks

Wahoo, KICKR and Zwift are trademarks of their owners. Velo names them only to
say which hardware it works with. It ships no Zwift assets, isn't affiliated
with either company and isn't endorsed by them.
