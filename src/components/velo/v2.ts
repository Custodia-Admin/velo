/**
 * Velo v2 "warm atlas" class recipes shared by the velo screens
 * (docs/design/v2-identity.md; mockups docs/design/mockups/v2-*.html).
 * Tokens only: each string is plain Tailwind on the UI-RULES §2 scale.
 */

/** Small upright sans label above a title. Never an italic serif (UI-RULES §7). */
export const KICKER = 'text-xs font-semibold uppercase tracking-widest text-muted-foreground';

/** Book serif for place names, page titles and the wordmark only. */
export const DISPLAY = 'font-display font-semibold';

/** The Velo wordmark. */
export const WORDMARK = 'font-display text-2xl font-bold tracking-tight';

/**
 * Solid in-ride surface: paper (day) / umber (night) at 90 %, no
 * backdrop-filter. Blur over the live WebGL canvas cost 10–25 fps (PR #16).
 */
export const HUD_PANEL = 'rounded-lg bg-hud/90 text-hud-foreground shadow-md';

/** Page column and gutters (UI-RULES §4). */
export const PAGE_X = 'px-4 sm:px-10';
export const COLUMN = 'mx-auto w-full max-w-5xl';
