# Classic view: Today's ride only features baked worlds (card t_35109bbf)

On 12 Nov 2026 Home's "Today's ride" was Lake Trasimeno shore, and the owner
rode it in the old renderer ("both the character and the map looked
old-style"). Trasimeno lies outside the Perugia world's bbox (route at
12.05–12.14° E, bbox west edge 12.317° E), so `worldForRoute` finds no world
and the ride falls back to Cesium photoreal. 11 of the 27 scenic routes are in
the same state.

## What changed

- **Velo's own suggestions only pick routes a baked world draws.** These are
  Today's ride, the pick behind Start when no route is loaded (`?demo=1` and
  the wizard's Start), and Finish's "Tomorrow, maybe".
  `suggestedScenicRoutes()` (`src/lib/scenicRoutes.ts`) gives the home routes
  for which `worldForRoute` (the catalog rule in `src/lib/world/catalog.ts`,
  by id or by bounds, remote worlds included) finds a world. A route joins the
  rotation the day its world is baked, with no list to edit.
- **One quiet tag on every route no baked world draws:** "Classic view". It
  shows on the Home tiles (in the weather line's slot), the wizard's scenic
  cards (inline after the figures) and, defensively, Today's ride (which
  never picks such a route). It replaces the "Map view" badge and the
  "3D world coming; rides on the map today" line. That old badge showed only
  in mixed sections, and it was wrong in a token build, where these routes
  ride the photoreal globe, not a map.
- The wishlist section line no longer says "these ride on the map today",
  because the tiles say it.

## Evidence (12 Nov 2026 09:00 Europe/Rome, the owner's day)

Before = main a2623de (`index-CnJme2nQ.js`, the deployed household build).
After = this branch (`index-BM3wwa1q.js`, same household env). Both builds were
staged with `scripts/v2-build-shots/common.py`: the same fixed weather, and
service workers blocked.

| Shot | What it shows |
| --- | --- |
| `home-{1440,1280,390}.jpg` | Today's ride: before **Lake Trasimeno shore** (map plate, classic view); after **Assisi valley floor** (world still) |
| `grid-perugia-*.jpg`, `grid-lugano-*.jpg` | Before "Map view" + line (only in mixed sections); after one tag on exactly the classic routes, day + night |
| `grid-wishlist-1440.jpg` | The wishlist: tags on its 6 classic routes |
| `grid-lugano-tv.jpg` | TV layout (1920×1080): tag 146×35 px, text 21 px |
| `wizard-{1440,1280,390}.jpg` | Build your own ride, step 1: tag on Trasimeno and Valle Maggia only |
| `mockup-vs-build-*.jpg` | `docs/design/mockups/v2-classic-view.html` next to the build |
| `design-gate-variants-1440.jpg` | Design gate: shipped badge vs A (pill beside the figures) vs C (plain words) vs the chosen design (quiet pill in its own slot) |

Measured on the built page (getBoundingClientRect, computed styles):

- Today's ride on 12 Nov: before `Lake Trasimeno shore`, after `Assisi valley floor`. No tag in the featured card.
- Tagged tiles: 11 on Home (Trasimeno; Valle Maggia, Magadino, Varese, Como;
  Engadin, Lavaux, Riviera dei Fiori, Annecy, Garda, Hangzhou). That is
  exactly the set `worldForRoute` returns null for. No "Map view" text
  anywhere.
- Tag: 84×20 px at 1440/1280/390 (146×35 on TV), `text-xs` 500 weight.
  Contrast is **5.28:1** in the day theme and **6.17:1** at night (AA).
- Row rhythm: Lugano row 1 has three tiles at 308 px (weather, weather, tag)
  and row 2 three at 306 px. Wizard cards are 67 px at 1440/1280. At 390 the
  Valle Maggia card grows to 91 px because the tag wraps under its longer
  figures, in a single column.
- No horizontal overflow at 1440, 1280×648, 390 or TV. 0 page errors. At
  1280×648 the Today's ride button sits at y 494–542, inside the viewport.

## §9 rubric

1. Tokens only: `bg-muted text-muted-foreground rounded-pill h-5 px-2
   text-xs font-medium`. `uiRules.test.ts` is green and its checked set is
   unchanged. **Pass**
2. One primary action (Today's ride → Ride) is unchanged. **Pass**
3. 1440: the tag is legible and quieter than the figures. Nothing is
   stretched (the tag is `self-start` in the tile column). **Pass**
4. 390: single column, no overflow or overlap. The tag wraps cleanly in one
   wizard card. **Pass**
4a. 1280×648: no overflow, and Ride is in view. **Pass**
5. Targets: the tag adds none (it sits inside the tile or card button).
   **Pass**
6. Copy: "Classic view" is two plain words, says what you get and works
   with or without a token. The tile label ends ", classic view". **Pass**
7. States: weather loading, ready and offline are unchanged on world tiles.
   Classic tiles show the tag in every weather state. **Pass**
8. Light and dark both checked (composites). **Pass**
9. Accessibility: the tile `aria-label` carries "classic view", and the
   wizard button's name includes the tag text. **Pass**
10. Side by side with the mockup and the shipped page: same product. **Pass**
