# Velo — product brief

Velo is a fork of [GlobeRide](https://github.com/masonwyatt23/globeride)
(MIT, © Mason Wyatt): a browser cycling app on a photoreal Cesium globe with a
Web-Bluetooth FTMS trainer. Velo keeps everything GlobeRide does and changes the
default experience for one household.

## Who rides

- **Two riders**, Federico and his wife, sharing one trainer.
- **Both have low motivation.** Training plans, FTP tests, streaks and TSS
  don't get them on the bike. Pretty places and something to watch do.
- What they said "enjoyable" means: **easy rides, amazing visuals, interactive
  elements**, or **set a journey and then watch our shows**.

## Where they ride

| Thing | Detail |
| --- | --- |
| Bike | Zwift Ride V2 frame (handlebar controllers) on a Wahoo KICKR CORE 2 |
| Trainer control | FTMS verified 29 Oct 2026: Request Control, SIM (0x11) and ERG (0x05) all answered Success. 0x04 resistance level fails (known KICKR quirk, not needed). |
| Screens | Laptop, TV, tablet. All Chrome, installed as a PWA. |
| Home | Perugia, Umbria (Italy). Federico grew up in Lugano, so Ticino and the Lombardy lakes stay in the library as "hometown". |

Velo never sends trainer commands outside a ride the rider started, and agents
never send BLE control commands while someone may be on the bike.

## Product direction

1. **Comfort first.** Easy is the default, not an option.
   - Trainer difficulty starts at **35 %**: a 6 % climb feels like 2 %.
     Adjustable per rider from the home screen ("Hills feel").
   - **ERG is off by default.** Workout power targets are shown as a guide; the
     trainer keeps following the road. Riders who want fixed power switch it on.
   - The home screen never asks for training effort: no plans, FTP, TSS or
     streaks. Those stay in the Advanced view for whoever wants them.
2. **Scenic over sporty.** The home screen leads with *Easy & Scenic* rides:
   flat or gently rolling routes with a big view. Near home first (Lake
   Trasimeno, the Tiber river park, the Assisi valley floor), then hometown
   (Lugano, Locarno, Valle Maggia, the Magadino plain, Lake Varese, Lake
   Como), further afield (Engadin lakes, Lavaux to Chillon, the Riviera dei
   Fiori, Lake Annecy, Lake Garda) and travels (Chengdu's Luxe Lakes,
   Hangzhou's West Lake, the Ohio & Erie Canal Towpath, Cleveland's
   lakefront, Berkeley, Santa Monica to Hermosa Beach, Puerto Vallarta).
   Each route has a cinematic mood (light, haze, time of day).
3. **Two riders, one tap.** "Who's riding" sits at the top of Home. Switching
   swaps weight, FTP, gear, avatar, camera, comfort settings and XP; the
   household keeps shared things like units, graphics and audio.
4. **Journey and show mode.** Press "Ride and watch" on today's ride, pick
   videos from this device, and the ride starts with them playing: a video
   panel over the live route (S / M / L), an auto camera that cycles chase,
   drone and orbit shots, one strip of ride numbers, and a HUD that fades
   after a few seconds without input. Stats and FIT export keep recording.
   Streaming tabs use Chrome's picture-in-picture; Velo explains how. The
   in-ride "Show" button does the same for any route.
5. **Live weather.** Open-Meteo (free, keyless, no account) gives the
   current weather at each route's start. Fair days keep the route's own
   light with clouds sized from the real cover; overcast, fog, rain, snow and
   storms switch the sky, fog, particles and wet road. Wind loads the trainer
   through the FTMS SIM Cw term, per rider: **Wind feel** off / **subtle**
   (default: a third of the real effect, capped at +25 % drag) / real. Cards
   show "Now: Fog · 9° · calm". Cached 20 min in localStorage; offline uses
   readings up to 3 h old, then the canned moods. "Live weather" (household)
   turns it all off. Math and mapping: `src/lib/meteo/`.
6. **10-foot UI.** Big targets and type that read from two metres on a TV and
   work under a thumb on a tablet. See `docs/design/UI-RULES.md`.
7. **Later, maybe.** A more game-like world (collectibles, companions,
   landmarks) once the comfort basics are loved. Zwift Ride handlebar
   controllers as input (public protocol, no Zwift assets or branding).

## Non-goals

- No accounts, subscriptions, or backend. Local-first like upstream.
- No Zwift assets, names or branding.
- No paid services. The Cesium ion token is the rider's own free-tier token.

## Rules for contributors (humans and agents)

- UI work follows `docs/design/UI-RULES.md` and its design gate.
- `npm run check` must pass before every push; full suites run in CI.
- Branch + PR into `Custodia-Admin/velo`; no merge without review.
- Keep the upstream MIT notice and the GlobeRide credit in the footer.

## Known gaps (tracked for later cards)

- Ride history, PRs and achievements in IndexedDB are shared, not per rider.
- The app header still says GlobeRide; a rebrand is its own card.
- Zwift Ride handlebar controller input is not wired yet.
- Show mode plays files Chrome can decode (MP4/H.264, WebM). Streaming
  services stay in their own tab via picture-in-picture; no integrations.
- Live wind applies to route rides (SIM). Structured workouts with explicit
  grade segments still send the base Cw.
