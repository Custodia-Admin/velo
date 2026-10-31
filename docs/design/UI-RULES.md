# Velo UI rules

Every Velo card that adds or changes UI follows these rules. That covers pages,
components, in-ride HUD, modals, and docs screenshots. A change that works but
is off-system **fails review**.

Product context lives in [`docs/VELO-BRIEF.md`](../VELO-BRIEF.md). Read it first.

---

## 0. Design gate (mandatory, in this order)

1. **Load the rules.** This file and `docs/VELO-BRIEF.md`.
2. **Mockup.** Static HTML or a throwaway branch render using the tokens in §2,
   at **1440×900** and **390×844**. Keep it in the PR description or under
   `docs/design/mockups/` if it is worth keeping.
3. **Vision review.** Look at the mockup renders against the §9 rubric. Fix
   what fails before writing component code.
4. **Build.** Only tokens and the shared primitives in §3.
5. **Compare.** Render the built UI at 1440 and 390, put it side by side with
   the mockup and with the pre-change screenshots of the same page. Use
   `scripts/ui-shots.py` (see the script header for usage).
6. **Ship.** The PR carries before/after shots at both widths and the §9
   rubric result. `src/test/uiRules.test.ts` must pass and its checked set
   must not shrink.

No screenshots looked at = not done.

## 1. Mode: lean-back, 10-foot

Velo is for two low-motivation riders on a trainer, looking at a TV, a tablet
on the bars, or a laptop. The default screen persuades gently and then gets out
of the way. In-ride UI is glanceable from two metres.

- One primary action per view. On Home that is "Ride" on a scenic route.
- Nothing on the default Home screen asks for training effort: no FTP, TSS,
  plans, streaks, or "you missed a day".
- Numbers serve the ride (time, distance, where am I), not performance.

## 2. Tokens

Tokens are defined once in `src/index.css` (CSS variables, light + dark) and
exposed through `tailwind.config.ts`. New UI uses **only** these.

| Kind | Allowed | Not allowed |
| --- | --- | --- |
| Colour | `background`, `foreground`, `card`, `card-foreground`, `muted`, `muted-foreground`, `border`, `primary`, `primary-foreground`, `accent`, `accent-foreground`, `destructive`, `destructive-foreground`, with opacity modifiers (`bg-primary/10`) | Tailwind palette colours (`emerald-400`, `rose-500`, `sky-400`…), hex / `rgb()` / `hsl()` literals in TSX |
| Type | `text-2xs` `text-xs` `text-sm` `text-base` `text-lg` `text-xl` `text-2xl` `text-3xl` `text-4xl` `text-5xl`; weights `font-medium` `font-semibold` `font-bold`; `.num` for figures | `text-[11px]` and any other arbitrary size |
| Space | Tailwind spacing scale (`gap-3`, `p-4`, `mt-6`) | arbitrary `[..px]` / `[..rem]` values |
| Radius | `rounded-sm` `rounded-md` `rounded-lg` `rounded-pill` `rounded-full` | `rounded-xl`, `rounded-2xl`, `rounded-[..]` in new code |
| Shadow | `shadow-sm` `shadow-md` `shadow-lg`; `shadow-glow-accent` on the single primary CTA only | `shadow-[...]` |
| Motion | `animate-*` tokens from the config; `duration-150/200/300` | custom keyframes in components |
| Surfaces | `Card` (glass) for top-level panels; plain `border bg-card` for items inside it | glass inside glass |
| Layout utilities | `max-w-show-fit` (show mode video panel: caps a 16:9 panel to the viewport height), `ride-banner-float` (no-token banner: centred above the transport bar; below `sm` it clears the mobile detail dock) | one-off `calc()` widths in TSX |

Need a new semantic colour (e.g. a "scenery" tint)? Add a CSS variable to both
themes in `src/index.css`, map it in `tailwind.config.ts`, and add it to the
table above in the same PR.

Raw values are allowed **only** inside `src/components/ui/*` primitives and
`src/index.css`, where the system itself is defined.

## 3. Components

- Use the primitives in `src/components/ui/`: `Button`, `Card` (+ `CardHeader`,
  `CardTitle`, `CardContent`), `Badge`, `SectionHeader`.
- Velo-specific UI lives in `src/components/velo/`. Everything in that folder
  is checked by `src/test/uiRules.test.ts`.
- Icons: `lucide-react`, `h-4 w-4` in body, `h-5 w-5` in primary buttons. No
  emoji as icons.
- Elevation sparklines: SVG with a `viewBox`, stroke via `currentColor` and a
  token text colour (`text-primary`).

## 4. Layout

- Content column: `max-w-5xl mx-auto`, page padding `px-4 sm:px-6 lg:px-10`.
- Grids: 1 column at 390, 2 at `sm`, 3 at `lg` for route cards.
- 390: no horizontal scroll, no text overlapping or truncated mid-word,
  primary action visible without hunting.
- 1440: nothing stretches past the content column; cards keep a readable
  measure (`max-w-prose` for paragraphs).

## 5. Touch and distance

- Minimum target: `h-10` (40 px). Primary actions: `Button size="lg"` (`h-12`).
- Body copy at least `text-sm`; route names at least `text-base`.
- In-ride figures at least `text-2xl`, labels at least `text-xs`.
- Focus ring from the global `:focus-visible` style; never remove it.
- Contrast: WCAG AA in both themes. Check `muted-foreground` on `card`.

## 6. Copy

- Plain words, short. Buttons say what happens: "Ride", "Pair trainer",
  "Switch rider". Not "Continue", "Get started", "Unlock".
- No jargon on Home. "Effort" or "How hard the hills feel" instead of
  "trainer difficulty" in headings; the setting name can appear as a label.
- Distances in the rider's unit; durations as "about 30 min".
- Credit upstream: GlobeRide (MIT) stays credited in the footer.
- No Zwift names, logos or assets.

## 7. Anti-slop (from the `impeccable` vocabulary)

Fail any of these and the change fails review:

- Cards inside cards, side-tab accent borders, coloured top-stripe on cards.
- Decorative gradient blobs or glows added by new UI.
- Vague headlines ("Your journey awaits"), italic serif kickers.
- Badges for everything. A badge must carry information the rider uses.
- Over-rounding, ghost cards (border with nothing in it), skeletons that never
  resolve.
- More than one accent-filled button visible in the same card.

## 8. States

Every new surface handles: loading (skeleton with the final layout), empty,
error (plain sentence + one action), active / selected, disabled. Both light
and dark theme.

## 9. Review rubric

Score each line pass / fail in the PR. Any fail blocks merge.

1. Tokens only (§2); `uiRules.test.ts` green, checked set unchanged or larger.
2. One clear primary action; hierarchy readable at a glance.
3. 1440: legible from two metres, nothing stretched.
4. 390: single column, no overflow, no overlaps, primary action reachable.
5. Targets ≥ `h-10`, primary `h-12`.
6. Copy follows §6, no training nagging on Home (§1).
7. States from §8 covered.
8. Light and dark both checked.
9. Accessible names on icon buttons, radio/toggle roles correct, focus visible.
10. Side-by-side with the reference page shows it belongs to the same product.

## 10. Reference pages and legacy

- **Reference:** `/app` Home (rider switcher, Easy & Scenic grid, comfort
  card) as shipped by P2a. Later cards compare against it.
- **In-ride reference:** show mode (P2b) — one glass ride strip, the show
  panel, and HUD fade on idle. New in-ride surfaces follow its pattern:
  glass top-level panel, `h-10`+ targets, figures `text-2xl`+, and nothing
  that competes with the video while the rider is idle.
- **Legacy:** upstream GlobeRide components use arbitrary px sizes and palette
  colours. They are grandfathered. Lines you touch in a legacy file move to
  tokens. Once a whole file is clean, add it to `CHECKED_FILES` in
  `src/test/uiRules.test.ts`; that list may grow, never shrink. Everything in
  `src/components/velo/` is checked from day one.
