# Velo v2 visual identity — "warm atlas"

Status: **proposal, waiting for Federico's sign-off** (P1.5 design gate). Nothing
here is applied to `src/` yet. P2.4 applies the tokens and builds the screens;
every P2 UI packet waits for sign-off on this direction.

Mockups: `docs/design/mockups/v2-{home,ride-hud,devices,show,finish}.html` (open
any of them in Chrome; add `?theme=night` for the night theme; a window
≥ 1600 px wide switches to the TV layout). Renders:
`docs/design/screenshots/v2/mockup/<screen>-<1440|390|tv>[-night].jpg`.
Side by side with the shipped app: `docs/design/screenshots/v2/compare/`.
Vision review against UI-RULES §9: [`v2-identity-review.md`](v2-identity-review.md).

## 1. The direction in one paragraph

Velo should feel like opening a good atlas on the sofa: warm paper by day, a
deep umber night after dark, one terracotta accent, place names set in a
book serif, and big photographs of the places you can ride. The UI tells you
where you are going and gets out of the way. No dashboards, no neon, no glass,
no gradient glow. Two riders, a TV across the room, low motivation: every
screen has one obvious thing to do and reads from three metres.

## 2. Principles

1. **The place is the hero.** Each ride leads with a large photographic plate of
   its world, rendered from Velo's own world bundles (§6). Text sits on a plain
   paper label, never on a gradient scrim.
2. **One accent.** Terracotta (the brick of Perugia) marks the single primary
   action, the selected state, the route line and "you are here". Nothing else
   is coloured. The old blue primary + green accent pair goes away.
3. **Paper and ink, not glass.** Surfaces are flat paper (`card`) with hairline
   borders. In-ride panels are solid `hud` surfaces at 90 % opacity, with no
   `backdrop-filter`. Blur over the live canvas cost 10–25 fps on the laptop
   (card t_12c297fd), so dropping glass is a performance decision as well as a
   visual one.
4. **Book serif for places, system sans for everything else.** Place names,
   page titles and the wordmark use Source Serif 4. Labels, numbers and buttons
   use the system UI sans with tabular figures.
5. **10-foot by construction.** The TV layout is the same UI at 1.75× (§4), so
   nothing is designed twice and nothing is too small on the TV.
6. **Calm in the ride.** The scene carries the ride, with the rider prominent
   and centred. The HUD keeps to the corners and one bottom strip, and every
   panel stays clear of the rider's box.

## 3. Themes

| | Paper day | Deep night |
| --- | --- | --- |
| Feel | Warm off-white paper, umber ink | Deep umber-black, warm paper-white text |
| When | Default in daylight | `prefers-color-scheme: dark` or the theme toggle; suggested for evening TV rides |
| Home hero | Golden-hour still | Blue-hour still of the same place (`data-night-src`) |
| HUD | Paper `hud` panels over the scene | Umber `hud` panels over the scene |

Contrast, from `python3 scripts/v2-contrast.py docs/design/mockups/v2-kit.css`:
every text pair passes WCAG AA in both themes. `muted-foreground` on `card` is
6.41 (day) and 7.16 (night). `primary-foreground` on `primary` is 5.39 and
6.23. `primary` used as text on `background` is 5.17 and 6.23. The only pair
under 3 is `border` on `background` (1.38 / 1.43). It is decorative: every
outlined control also has a text label.

## 4. Type and the TV scale

- **Display:** `Source Serif 4` (variable, OFL 1.1). It is self-hosted, never a
  network font: the Latin `wght` subset is 51 KB as woff2, ships in `public/fonts/`
  and is precached by the PWA. Fallbacks are `'Iowan Old Style', Charter, 'Noto
  Serif', Georgia, serif`. Weight 600 for titles, 700 for the wordmark. Use it
  for place names, page titles and the wordmark only. Never italic. UI-RULES §7
  bans italic serif kickers.
- **UI:** the existing system sans stack. `.num` (tabular figures) for every
  number.
- **Scale:** unchanged (`text-2xs` … `text-5xl`). Kickers are `text-xs`
  uppercase sans with 0.08em tracking.
- **TV:** `html[data-layout="tv"] { font-size: 175% }` makes 1 rem 28 px. Every
  size and space token is in rem, so the whole UI scales together. On a
  1920×1080 TV that gives:

  | Token | Laptop | TV |
  | --- | --- | --- |
  | `text-xs` (labels) | 12 px | **21 px** |
  | `text-sm` (body) | 14 px | **24.5 px** |
  | `text-base` | 16 px | 28 px |
  | `text-2xl` (min in-ride figure) | 24 px | 42 px |
  | `text-3xl` (HUD figures) | 30 px | 52.5 px |
  | `h-10` / `h-12` targets | 40 / 48 px | 70 / 84 px |

  Body text is ≥ 18 px, as the packet asks, and it also meets the tvOS and
  Android TV body sizes (about 28 px at 1080p for `text-base`). The smallest
  text measured in any TV mockup is 21 px (`measurements.json`). The layout at
  1920 wide behaves like the ~1100 px laptop layout. Detection (auto at
  ≥ 1600 px with no fine pointer, or the user's choice) belongs to P3.3. The
  mockups switch on viewport width only. UI-RULES §5 now has the TV addendum.

## 5. Screens

| Screen | What it is | Key decisions |
| --- | --- | --- |
| **Home** (`v2-home`) | "Where to today?", rider switcher, today's ride as a large plate, then areas | **Today's ride plate:** a paper label in the lower left holds the title, a one-line description, a 32-unit profile, distance, character and time, live weather, **Ride** (the only filled button) and a quiet "Ride and watch".<br>**Comfort:** shrinks to one line ("Hills feel 35 % · easy · Wind feel subtle · Change"). The sliders open from Change.<br>**Areas:** places with a baked world get photo plates. Places without one get a **map plate** (the real route on a 1 km graticule) and a "Map view" badge, because the rider gets the map look there today.<br>**No cards:** tiles are a plate plus text on paper, with no box around them. |
| **Ride HUD** (`v2-ride-hud`) | Chase camera with the rider about 35 % of frame height, centred | **Top left:** Exit, then a route panel: name, "6.7 km to go · about 20 min", profile with a you-are-here dot, next landmark.<br>**Top right:** trainer status ("KICKR CORE · hills 35 %"), Show, Camera, Settings.<br>**Bottom:** one strip with speed, time and distance (`text-3xl`); grade, power and gear (`text-2xl`); then Pause (outline) and Finish (quiet).<br>**Optional:** cadence and heart rate join the strip only when a sensor is paired. The minimap stays behind the existing detail dock / Map toggle.<br>**390:** two figure rows and the transport; the rider box keeps 14 px clear of the strip. |
| **Devices** (`v2-devices`) | One panel, one row per device, hairline separators | **Rows:** each row has a glyph, the name and a state line, battery when known, and one action.<br>**States shown at once:** connected, connected with battery, "Couldn't find it" (icon, plain sentence, Try again), and not paired (optional heart rate).<br>**Ride:** sits top right on laptop and TV, and is a sticky bottom bar at 390. "The right handlebar can join later" says the ride doesn't need every device.<br>**Tips:** pairing tips plus the iPad/iPhone note ("Browsers there can't pair Bluetooth…"). |
| **Show** (`v2-show`) | Rider's own video in a panel over the live ride, drone shot, one ride strip | **Video panel:** L size (55 vw) top left, with S/M/L, next video, and "Watch another tab" for the Document PiP flow (P2.3).<br>**Strip:** time, distance, grade, next landmark and ride pause.<br>**Rider:** in the right third, about 9 % of frame height, never under the panel.<br>**Idle:** the HUD fades as in p2b.<br>**Video frame:** a neutral placeholder. Mockups contain no third-party footage. |
| **Finish** (`v2-finish`) | 21:9 photo plate of where you rode, then a summary | **Summary:** "Ride finished · saved on this device", the place name, four plain figures (distance, time, climbed, average), the full profile, and **Back to Home** as the only filled button.<br>**Secondary:** Download FIT and Send to Strava, both outline.<br>**Footer line:** postcards found, and "Tomorrow, maybe: Assisi valley floor".<br>**Left out on purpose:** no scores, no training load, no PR pressure. |

Every screen was rendered at 1440×900, 390×844 (2×) and 1920×1080 (TV), in both
themes: 30 renders in `screenshots/v2/mockup/`. Measurements for each render are
in `screenshots/v2/mockup/measurements.json`: no horizontal overflow, smallest
target 40 px (70 px on TV), smallest text 12 px (21 px on TV).

## 6. Imagery: world stills, not stock

- **Source:** all photographs come from Velo's own world bundle (Perugia,
  `public/worlds/perugia/`). They are rendered by `scripts/v2-world-thumbs/`, an
  offline three.js stills renderer with supersampling, 8k shadow maps, leaf-card
  trees and a film grade. Views are in `views.json`; run
  `uv run --with playwright --with pillow --with numpy python scripts/v2-world-thumbs/shoot.py`
  (about 15–25 s per still on the laptop GPU). The output is 11 stills in
  `screenshots/v2/thumbs/`, each ≤ 350 KB.
- **Proposed production path (P2.4 + P2.2):** stills are baked assets, not live
  renders. Each world bundle gains `posters/<view>.jpg`, made by this tool at
  bake time on cat-bed. Home then never starts a WebGL context, which avoids the
  mobile OOM risk of several live mini-globes. New destinations get posters
  when they are baked. Until then they show the map plate.
- **Framing rules:**
  - The chase camera puts the rider at 30–40 % of frame height (22–28 % in
    portrait), centred, with the road leading in. This matches the owner's
    note that the chase camera sat too far back.
  - Keep corners and the bottom 15 % calm for HUD panels.
  - Home heroes keep the lower-left third darker for the label.
- **Honest quality note:** a targeted vision check rates these stills about
  4/10 for "photographic" (the old renders were about 2/10). The light and the
  grade work. Ground textures, buildings and the rider still read as CG. They are
  good enough to judge layout and mood, not the final look. The real-time world
  look belongs to P2.1, and its acceptance shots are Federico's "would I want to
  ride here" check.

## 7. Token delta for P2.4 (names + HSL only)

Apply in `src/index.css` (`:root` = paper day, `.dark` = deep night) and map in
`tailwind.config.ts`. Values are `H S% L%` as the existing tokens use.

### Changed

| Token | Paper day | Deep night | Was (day / night) |
| --- | --- | --- | --- |
| `--background` | `40 30% 96%` | `26 14% 7%` | `210 30% 97%` / `220 42% 4%` |
| `--foreground` | `28 22% 12%` | `38 28% 91%` | `220 40% 10%` / `210 28% 96%` |
| `--card` | `40 40% 99%` | `26 12% 10%` | `0 0% 100%` / `220 40% 7%` |
| `--card-foreground` | `28 22% 12%` | `38 28% 91%` | `220 40% 10%` / `210 28% 96%` |
| `--muted` | `38 22% 90%` | `26 10% 15%` | `210 24% 93%` / `215 28% 13%` |
| `--muted-foreground` | `30 12% 36%` | `34 12% 64%` | `215 15% 46%` / `215 18% 58%` |
| `--border` | `36 18% 82%` | `26 10% 19%` | `214 24% 86%` / `215 26% 17%` |
| `--primary` | `14 64% 42%` | `16 72% 60%` | `200 92% 42%` / `200 92% 56%` |
| `--primary-foreground` | `40 40% 98%` | `26 14% 7%` | `0 0% 100%` / `220 42% 4%` |
| `--accent` | `14 64% 42%` (= primary) | `16 72% 60%` (= primary) | `158 80% 32%` / `158 80% 42%` |
| `--accent-foreground` | `40 40% 98%` | `26 14% 7%` | `0 0% 100%` / `220 42% 4%` |
| `--destructive` | `356 60% 40%` | `356 70% 64%` | `4 84% 53%` / `4 80% 60%` |
| `--destructive-foreground` | `40 40% 98%` | `26 14% 7%` | `0 0% 100%` / `210 28% 96%` |
| `--radius` | `0.625rem` | (same) | `0.875rem` |

`accent` keeps its name so legacy components compile. It becomes an alias of
`primary` (one accent). New code uses `primary` only.

### New

| Token | Paper day | Deep night | Tailwind | Use |
| --- | --- | --- | --- | --- |
| `--hud` | `40 30% 97%` | `26 14% 8%` | `bg-hud/90` | Solid in-ride panels; replaces glass on the ride path |
| `--hud-foreground` | `28 22% 12%` | `38 28% 91%` | `text-hud-foreground` | Text on `hud` |
| `--scrim` | `28 30% 6%` | `28 30% 6%` | `bg-scrim` | Video frame / scene letterbox; shadows' colour |
| `--on-scrim` | `40 33% 97%` | `40 33% 97%` | `text-on-scrim` | Text on `scrim` (video bar) |
| font `display` | — | — | `font-display` | `'Source Serif 4 Variable', 'Iowan Old Style', Charter, 'Noto Serif', Georgia, serif` |
| screen `tv` | — | — | `tv:` variant = `[data-layout="tv"] &` | TV-only tweaks (rare; the 1.75× root does most of it) |
| layout utility `max-h-hero-fit` | — | — | `src/index.css` utility | Home hero / finish plate: caps the plate to the viewport so the label and primary action stay on screen (`100vh - 13rem` / `- 26rem`) |

### Retired on the ride path

`--glass-*` stay defined for legacy components, but no `src/components/velo/`
surface uses glass any more. P2.4 moves the ride HUD to `hud`.

The `uiRules.test.ts` allow-list stays as it is. All of the above are tokens or
named utilities, so P2.4 adds no raw values to components. The UI-RULES §2
token table gains the new rows in the P2.4 PR that applies them.

## 8. What P2.4 should not do

- Don't restyle the legacy upstream screens (landing, training, explore). The
  new tokens recolour them, and that is enough.
- Don't add a second accent for "success" or "connected": connected = `primary`
  dot + the word "Connected".
- Don't put text directly on photographs. It always goes on a `background` /
  `hud` label.

## 9. Questions for Federico (sign-off)

1. Is the direction right: warm paper and umber night, terracotta as the single
   accent, a serif for place names?
2. Should the TV scale stay at 1.75× (1 rem = 28 px)? 1.5× fits more on screen
   but is smaller than TV-platform body text.
3. Is a map plate fine for destinations without a baked world, or should they
   wait off Home until their world exists?
4. The stills are about 4/10 photographic. Is that good enough to judge the
   direction now, with the world look itself judged in P2.1?
