# Velo v2 identity — vision review (UI-RULES §9)

Scope: the five P1.5 mockups (`docs/design/mockups/v2-*.html`) rendered at
1440×900, 390×844 (2×) and 1920×1080 TV, paper day and deep night: 30 renders in
`docs/design/screenshots/v2/mockup/`. Side by side with the shipped app:
`docs/design/screenshots/v2/compare/`. Re-render with
`uv run --with playwright --with pillow python scripts/v2-mockup-shots.py`. That
also writes `measurements.json`: overflow, smallest visible text, smallest
target, for every render.

Method: every render was looked at through a vision model with a blunt-critic
prompt. Vision models misjudge alignment and presence, so every geometric claim
was checked with `getBoundingClientRect` before acting on it. Claims that the
measurement disproved are listed as such below.

## Rubric

| # | Line | Result | Evidence |
| --- | --- | --- | --- |
| 1 | Tokens only (§2); `uiRules.test.ts` green, checked set unchanged or larger | **Pass** | Mockup CSS uses only `var()` tokens from `v2-kit.css`; the TOKENS block there is the §7 delta in `v2-identity.md`. No inline `style=` in any mockup (`grep -c 'style=' docs/design/mockups/v2-*.html` = 0). No `src/` change in this packet. `npx vitest run src/test/uiRules.test.ts` green, allow-list untouched. |
| 2 | One clear primary action; hierarchy readable at a glance | **Pass** | One filled `primary` button per view. **Home:** Ride. **Devices:** Ride. **Finish:** Back to Home. **Ride HUD and show:** none filled; Pause is the main control, as an outline. The vision review flagged "Ride and watch" as competing when it was an outline, so it became a quiet text button. The Finish actions were unified to outline + one primary. |
| 3 | 1440: legible from two metres, nothing stretched | **Pass** | Content column `max-w-5xl` (1024 px). HUD figures `text-3xl` (30 px), labels `text-xs`. The hero plate is capped to the viewport (`max-h-hero-fit`), so the label and Ride sit above the fold (label bottom y 704 of 900). |
| 4 | 390: single column, no overflow, no overlaps, primary action reachable | **Pass** | `overflow=False` on all 390 renders.<br>**Home:** Ride is on the first screen.<br>**Devices:** Ride is a sticky bottom bar (y 725–773; the vision model said the text under it was cut off; measured bottom 828 < 844).<br>**Ride HUD:** the strip starts at y 698; the rider box ends at 684 (14 px clear).<br>**Show:** the rider (y 602–663) sits between the video panel (bottom 218) and the strip (top 698). |
| 5 | Targets ≥ `h-10`, primary `h-12` | **Pass** | Smallest target in every laptop/phone render is 40 px (70 px on TV). All primary buttons are `lg` (48 px; 84 px on TV). |
| 6 | Copy follows §6, no training nagging on Home (§1) | **Pass** | Buttons say what happens: Ride, Ride and watch, Try again, Pair, Download FIT, Send to Strava, Back to Home. Durations read "about 35 min", from `estimateEasyMinutes` (20 km/h flat, 17 gentle). No FTP, TSS, streaks or scores anywhere; Finish suggests "Tomorrow, maybe: …". Error copy is one plain sentence and one action. GlobeRide credit kept in the footer. |
| 7 | States from §8 covered | **Pass (mockup level)** | **Devices:** connected, connected + battery, error ("Couldn't find it" + icon + Try again), empty/not paired, unsupported browser (iPad note).<br>**Home:** baked world (photo plate) vs not baked (map plate + "Map view" badge); selected rider (radio checked).<br>**Show:** the active state is drawn; the idle fade is the p2b behaviour, unchanged.<br>**Not drawn:** loading skeletons. P2.4 must use the final layout: the plate as a `muted` block of the same aspect, the label text as bars. |
| 8 | Light and dark both checked | **Pass** | Every screen rendered in both themes. WCAG AA for all text pairs in both, via `scripts/v2-contrast.py` (table in `v2-identity.md` §3). Night Home swaps in the blue-hour still. The vision check called the night theme "warm, not blue-grey". |
| 9 | Accessible names on icon buttons, radio/toggle roles correct, focus visible | **Pass** | Every icon-only button has an `aria-label`: Settings, Show, Camera, Ride settings, Pause video, Next video, Close show mode, Pause ride, Exit. Rider switcher and video size use `role=radiogroup` / `radio` + `aria-checked`. Map-plate tiles have an `aria-label` that names the route. The global `:focus-visible` ring (2 px `primary`) is kept in the kit. |
| 10 | Side-by-side with the reference page shows it belongs to the same product | **Pass, as a deliberate re-identity** | `compare/*.jpg`: the structure is kept (who's riding → today's ride → areas; one bottom ride strip; show panel over the ride; finish summary + FIT). The look changes on purpose; P2.4's build becomes the new §10 reference. The vision comparison: the redesign is "calmer, warmer, more premium" and keeps the structure. It lost the inline hills/wind sliders (now behind Change) and RPM/BPM/minimap in the HUD (they appear when a sensor is paired; the minimap stays behind the Map toggle). |

## Fixes made after the first vision pass

- **Home:**
  - "Ride and watch" went from outline to quiet, so Ride is the only strong
    button.
  - "Change" became an underlined text button (it read as placeholder text).
  - The vision claim "header buttons misaligned" was false: both measure
    top 12 / bottom 52.
- **Ride HUD:**
  - The route line said "4.2 of 10.9 km", which duplicated the distance figure.
    It now says "6.7 km to go · about 20 min".
  - Pause moved from a `hud` button, which blended into the strip, to outline.
- **Devices:**
  - The error row gained an icon.
  - Ride moved top right on laptop/TV. On TV it was below the fold at y 1009–1159;
    it is now at y 252–336. At 390 it is a sticky bottom bar.
  - "The right handlebar can join later" makes it clear that riding doesn't
    wait for every device.
- **Show:** the first drone still had the rider at 2 % of frame height
  ("barely findable"). The camera was re-framed to 36 m off the route at fov 28,
  so the rider is now 9 %, at x 72 %, clear of the video panel.
- **Finish:** gave the profile room below the buttons; Download FIT matches Send
  to Strava (both outline).
- **TV:** the first pass used a 1.5× root (text-sm 21 px). The vision check said
  secondary text was still small from 3 m, and TV platforms use ~28 px body, so
  the root went to 1.75×. The ride strip still clears the rider: rider bottom
  y 880, strip top y 891.

## Known gaps (carried to P2.1 / P2.4)

1. **World stills read as CG** (targeted vision check about 4/10 photographic;
   the old renders were about 2/10). Light and grade work; ground texture,
   buildings and the rider model are the weak parts. P2.1 owns the world look.
   Federico's comment that the current visuals are "cartooney" is only
   partially answered by these stills.
2. **The video frame in show mode is a placeholder** (no third-party footage in
   mockups).
3. **Loading skeletons** are specified in rubric line 7 but not drawn.
4. **TV detection** is width-only in the mockups; P3.3 owns the real rule.
