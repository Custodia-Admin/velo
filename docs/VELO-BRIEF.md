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
| Home | Ticino, Switzerland. Lombardy is next door. |

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
   flat or gently rolling routes with a big view. Near home first (Lugano,
   Locarno, Valle Maggia, the Magadino plain, Lake Varese, Lake Como), then
   further afield (Engadin lakes, Lavaux to Chillon, the Riviera dei Fiori,
   Lake Annecy). Each route has a cinematic mood (light, haze, time of day).
3. **Two riders, one tap.** "Who's riding" sits at the top of Home. Switching
   swaps weight, FTP, gear, avatar, camera, comfort settings and XP; the
   household keeps shared things like units, graphics and audio.
4. **Journey and show mode (next).** Pick a route, press Ride, and watch your
   own shows while the world rolls by: a video surface over the live route,
   auto-cinematic camera, stats and FIT export still recording. Card P2b.
5. **10-foot UI.** Big targets and type that read from two metres on a TV and
   work under a thumb on a tablet. See `docs/design/UI-RULES.md`.
6. **Later, maybe.** A more game-like world (collectibles, companions,
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
