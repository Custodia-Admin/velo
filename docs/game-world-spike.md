# Game-like world: spike

Card P3, 30 Oct 2026. Question: can Velo get a playful, game-like layer for
easy rides inside the current Cesium stack, without spending money and without
copying anyone's worlds? And where does a generated world (Google Genie) plug
in later?

**Recommendation: build one mode now.** Postcards along the road and a riding
buddy, behind a per-rider *Play mode* switch that is off by default. It's
cheap (no assets, no network, no new dependencies), it works on every route
including the Easy & Scenic set, and nothing in it can be lost or failed. The
other options are parked with reasons below.

## Who it is for

Two low-motivation riders sharing one trainer (`docs/VELO-BRIEF.md`). What
gets them on the bike is pretty places and something to watch. So the game
layer has three rules:

1. **Nothing to lose.** No timers, no missed pickups, no streaks that break,
   no leaderboard. If you ride the route, you get everything.
2. **Glanceable.** One chip and a short note, readable from two metres
   (UI-RULES §1 and §5). No new controls during the ride.
3. **An option.** The photoreal Earth stays the default. Play mode adds to it
   and can be switched off per rider.

## Options evaluated

Scored on fun for these two riders, cost (build days, assets, money), risk to
the ride loop and the mobile memory budget, and how it fits the rules above.

| # | Option | Fun | Cost | Risk | Verdict |
| --- | --- | --- | --- | --- | --- |
| A | Fantasy 3D Tiles / glTF overlays on real terrain (castles, giant flowers, floating islands) | High once it exists | High: needs an art pipeline. Free CC0 packs exist but placing them on 15 real routes by hand is days of work per route | Medium: extra tilesets and models are what OOMs mobile | **Park.** Revisit with a small CC0 prop kit if postcards land well |
| B | Stylised mood worlds: the 8 cinematic moods plus a `CustomShader` on the photoreal tileset (posterise, warm palette, "storybook" look) | Medium-high | Low-medium: one shader, no assets | Medium: only visible with a valid ion token and photoreal tiles; the local token is a placeholder (OSM fallback), so it can't be verified here | **Next candidate.** Cheap, but needs a real-token render pass to judge |
| C | Imagery-layer styling (hue, saturation, gamma on the base map) | Low | Very low | Low | Too subtle on its own; fold into B |
| D | **Postcards along the road**: collectible markers every ~0.8 km, picked up by riding past, counted in a chip and on the finish card | Medium-high: a reason to keep going to the next one, a small win every few minutes | Low: procedural billboard drawn on a canvas, pure placement logic | Low: at most 12 entities per route, all removed on route change and viewer destroy | **Build** |
| E | **Riding buddy**: the other rider's avatar beside you. When they've ridden this route, they move with their own recorded pace; they never get more than ~12 m away, so they wait for you and pull you along instead of dropping you | High for a couple: "riding with her" even on separate evenings | Low: reuses the avatar, ghost interpolation and the rider roster | Low: one extra avatar (the pace bots already do this) | **Build**, together with D |
| F | Exact ghosts of your own past rides | Exists already | None | None | Keep as is. It's competitive by design (fastest-first), so it isn't the game layer |
| G | Badges and streaks | Low for these riders | Low | Off-brief: UI-RULES §1 bans streaks and training nagging on Home | **No.** Postcard counts on the finish card are the only "reward" |
| H | Landmark callouts ("Brissago Islands on your left") | Medium | Medium: per-route content | Low | Later. Postcards can carry these lines once someone writes them |

Not done: anything that copies Zwift worlds, assets, names or branding. Postcards,
the buddy and the visual style are Velo's own. The billboard is drawn in code.

## The world layer contract (where Genie or anything else plugs in)

The trainer side (FTMS, the ride loop, physics, FIT recording) doesn't know
what draws the world. This spike makes that explicit with a small interface in
`src/lib/world/worldLayer.ts`:

```ts
interface RideFrame {          // what the ride produces each frame
  elapsedMs; dt;               // time
  distanceM; routeLengthM;     // where on the route
  speedMs; powerW; cadenceRpm; gradePct;
}

interface WorldLayer {         // what any world renderer implements
  readonly id: string;
  update(frame: RideFrame): void;
  dispose(): void;
}
```

- The Cesium play layer (`src/lib/play/cesiumPlayLayer.ts`) is the first
  implementation. It is created per route, fed one `RideFrame` per rendered
  frame from `CesiumViewer`'s `preRender`, and disposed on route change,
  toggle-off and viewer destroy.
- Game logic (postcard placement and pickup, buddy gap) is pure and
  renderer-free in `src/lib/play/postcards.ts` and `src/lib/play/buddy.ts`. A
  different renderer reuses it unchanged: it only needs to draw "postcard at
  distance d" and "buddy at distance d".
- The slope that the trainer feels still comes from the GPX route, never from
  the renderer. A generated world can't push resistance into the legs, and it
  shouldn't.

## Google Genie: where it could plug in, and why not now

From the 29 Oct assessment (`genie-and-meteo-assessment.md` in the findn6
brief jobs): Genie 4 is a trusted-tester research preview. Project Genie runs
60-second sessions (Genie 4: about 2 minutes), takes WASD keyboard input only,
has no public API or pricing, sits behind a paid Google AI Ultra plan, and
can't reproduce real places.

| Need | Genie today | Consequence |
| --- | --- | --- |
| 30–90 min rides | 1–2 min sessions | Only works as short interludes |
| Bike drives the world | Keyboard only, no input API | Nothing to feed `RideFrame` into |
| Real routes, real slope | Can't reproduce real locations | Can't replace the Earth; slope must stay GPX-driven |
| No spending, no accounts | Paid plan, preview ToS | Blocked by the brief |

If an API opens, the plug-in point is a `GenieWorldLayer implements WorldLayer`:

1. **Input:** map `RideFrame` to its control stream (speed to "forward",
   route heading change to "turn"). Gradient stays with the GPX and the
   trainer.
2. **Prompt:** build the scene prompt from what we already know: the route's
   scenery (`lake`, `valley`, `coast`), its cinematic mood, and live weather
   (P2c). Example: "lakeside promenade at golden hour, light haze".
3. **Shape:** short "dream interludes" (for example the flat middle of a long
   route), cross-faded over the Cesium view the way the P2b show panel layers
   video. The ride, the HUD and FIT recording keep running underneath.
4. **Postcards and the buddy keep working**, because they live in the pure
   game logic, not in Cesium.

Action: none now. Join the waitlist, revisit in about three months, don't plan
around it.

## What was built (option D + E)

- **Switch:** "Play mode" under "Hills feel" on Home, per rider (stored with
  the rider's other comfort settings, so one rider can have it on and the
  other off). Off by default.
- **Postcards:** placed every ~0.8 km (3 to 12 per route, none in the first
  300 m or the last 150 m). Picked up automatically within 8 m, so riding the
  route collects them all. Each is a small card with a stamp in the accent
  colour, drawn on a canvas in code, bobbing 2.4 m above the road. Only cards
  within 1.2 km are drawn. They start at the route's elevation and are
  re-seated on the rendered ground once the rider is within 400 m (clamping
  to the globe buried them in the no-token map fallback, where the globe is
  an ellipsoid at 0 m). On pickup: the card grows and fades, the existing
  achievement chime plays if ride sound is on, and the panel says "Postcard 4
  collected" for 6 s. Otherwise it says "Next one in 350 m". The finish card
  shows "Postcards 9 of 12".
- **Riding buddy:** the other rider from the roster, in their own avatar
  colours (a different preset if theirs matches yours), 1.5 m to your left.
  Ride records now carry `riderId`. If the buddy has ridden this route, their
  latest recorded pace decides whether they're a little ahead or behind,
  clamped to ±12 m and eased so they never jump. If not, they ride level with
  a gentle ±3 m drift. Panel line: "Anna rides with you" or "Anna rides with
  you · pace from 28 Oct".
- **Phones (below `sm`):** a one-row panel (note + count). The mobile minimap
  gives its place to it while Play mode is on, so the HUD stack ends higher
  than before and stays clear of Pause/Finish.
- **Not changed:** trainer control, gradient, physics, recording, FIT export,
  existing ghosts and pace bots. Records saved before this change have no
  `riderId`, so the buddy rides level until the other rider has ridden the
  route once. The buddy's rides still also show as ordinary ghosts when
  Ghosts are on (existing behaviour).

Code: `src/lib/world/worldLayer.ts`, `src/lib/play/` (pure rules + Cesium
layer), `src/hooks/usePlayLayer.ts` (lifecycle, own `preRender` hook, one
line in `CesiumViewer`), `src/stores/playStore.ts`,
`src/components/velo/PlayMode.tsx`. Screenshots and the design-gate review:
`docs/design/p3-play-mode-review.md`.

## Next, if this lands well

1. Stylised "storybook" world (option B) as a second Play option: a
   `CustomShader` on the photoreal tileset. Needs a render pass with a real
   ion token.
2. Postcard lines per scenic route ("Brissago Islands offshore"), written by
   hand, shown on pickup and collected into a per-rider album.
3. A `GenieWorldLayer` only once a public API exists (see above).
