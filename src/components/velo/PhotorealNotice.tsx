/**
 * The photoreal notice: one small pill in the ride HUD's chip lane, right of
 * the status chip (card t_375b203d; mockup
 * docs/design/mockups/v2-ride-photoreal-notice.html). It replaces the old
 * floating NoTokenBanner, which sat centred above the band and at 390 wrapped
 * into a seven-line column over the rider (19.2 % of the screen with the
 * band, 22.3 % with a chip).
 *
 * Two notices about the photoreal (Cesium) view, rides outside every baked
 * world only:
 *
 *   - 'upgrade': no Cesium ion token installed. The ride runs on OSM imagery;
 *     a free token unlocks Bing aerial, World Terrain and Google photoreal
 *     tiles. The text is the button that opens Settings on the Visual tab,
 *     where the token goes.
 *   - 'fallback': a token is installed but the Bing imagery stalled
 *     (IMAGERY_FALLBACK_EVENT from cesiumUtils' watchdog), so the map
 *     fallback shows. A status line, no action.
 *
 * Each one is dismissed for the session (sessionStorage, its own key: hiding
 * the pitch never hides an outage notice). One line, h-10 like the chip, so
 * the lane never grows. The chip lane (RideChip `aside`) puts it at the
 * band's right end on sm+ (the chip holds the left end, the rider the
 * middle) and alone at the start on phones, and hides it while the chip
 * carries an alert, so it never competes with "Trainer lost" or "3D view
 * stopped".
 */

import { useEffect, useMemo, useState } from 'react';
import { CloudOff, Earth, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { IMAGERY_FALLBACK_EVENT } from '@/lib/imageryFallback';
import { HUD_PANEL } from './v2';

export const UPGRADE_DISMISS_KEY = 'globeride.noTokenBannerDismissedAt';
export const FALLBACK_DISMISS_KEY = 'globeride.imageryFallbackBannerDismissedAt';

/**
 * The notice copy: one short line on every viewport. At 390 the pill must stay
 * one line and about 300 px wide, so the band (10.9 % of the screen) plus the
 * pill stays under the owner's 15 % ride-UI budget; on sm+ the pill sits at
 * the band's right end, clear of the chase-camera rider in the middle (a
 * longer line reached the rider's wheels at 1440).
 */
export const NOTICE_COPY = {
  upgrade: {
    line: 'Add a free token for photoreal',
    aria: 'Add a free Cesium ion token for photoreal Earth. Opens Settings.',
    dismiss: 'Dismiss photoreal upgrade banner',
  },
  fallback: {
    line: 'Photoreal unavailable for now',
    dismiss: 'Dismiss photoreal-unavailable notice',
  },
} as const;

export type PhotorealNoticeKind = keyof typeof NOTICE_COPY;

export interface PhotorealNoticeState {
  kind: PhotorealNoticeKind;
  /** Settings, Visual tab (where the token goes). */
  onOpenSettings: () => void;
  /** Hide this notice for the rest of the session. */
  onDismiss: () => void;
}

/**
 * Which notice shows, if any. The outage notice wins over the pitch (it says
 * what is wrong right now); with no token there is nothing to fall back
 * from. Pure.
 */
export function photorealNotice(i: {
  hasToken: boolean;
  fallbackSeen: boolean;
  upgradeDismissed: boolean;
  fallbackDismissed: boolean;
}): PhotorealNoticeKind | null {
  if (i.hasToken && i.fallbackSeen && !i.fallbackDismissed) return 'fallback';
  if (!i.hasToken && !i.upgradeDismissed) return 'upgrade';
  return null;
}

function readSessionDismissed(key: string): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return sessionStorage.getItem(key) !== null;
  } catch {
    return false;
  }
}

function writeSessionDismissed(key: string): void {
  try {
    sessionStorage.setItem(key, String(Date.now()));
  } catch {
    // sessionStorage may be blocked (private browsing): the notice then
    // comes back on the next ride, never within this one.
  }
}

/** SettingsPanel listens for this and opens on the Visual tab (the ion token). */
export function openPhotorealSettings(): void {
  window.dispatchEvent(new CustomEvent('globeride:open-settings', { detail: { tab: 'visual' } }));
}

/**
 * The notice for this ride, or null. Ride mounts it for the whole ride, so
 * an imagery fallback that fires while the details or show mode hide the
 * notice is still shown afterwards.
 */
export function usePhotorealNotice(hasToken: boolean): PhotorealNoticeState | null {
  const [upgradeDismissed, setUpgradeDismissed] = useState(() => readSessionDismissed(UPGRADE_DISMISS_KEY));
  const [fallbackDismissed, setFallbackDismissed] = useState(() => readSessionDismissed(FALLBACK_DISMISS_KEY));
  const [fallbackSeen, setFallbackSeen] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onFallback = (): void => setFallbackSeen(true);
    window.addEventListener(IMAGERY_FALLBACK_EVENT, onFallback);
    return () => window.removeEventListener(IMAGERY_FALLBACK_EVENT, onFallback);
  }, []);

  const kind = photorealNotice({ hasToken, fallbackSeen, upgradeDismissed, fallbackDismissed });

  return useMemo(() => {
    if (!kind) return null;
    return {
      kind,
      onOpenSettings: openPhotorealSettings,
      onDismiss:
        kind === 'upgrade'
          ? () => {
              writeSessionDismissed(UPGRADE_DISMISS_KEY);
              setUpgradeDismissed(true);
            }
          : () => {
              writeSessionDismissed(FALLBACK_DISMISS_KEY);
              setFallbackDismissed(true);
            },
    };
  }, [kind]);
}

/** The pill: icon + one line (the Settings button for the pitch) + dismiss. */
export function PhotorealNoticeView({
  kind,
  onOpenSettings,
  onDismiss,
  className,
}: PhotorealNoticeState & { className?: string }) {
  const copy = NOTICE_COPY[kind];
  const line = (
    <span className="truncate" data-notice-text>
      {copy.line}
    </span>
  );
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="photoreal-notice"
      data-kind={kind}
      className={cn(
        HUD_PANEL,
        'pointer-events-auto inline-flex h-10 min-w-0 max-w-full items-center border border-border/60 text-sm font-semibold',
        className,
      )}
    >
      {kind === 'upgrade' ? (
        <button
          type="button"
          onClick={onOpenSettings}
          aria-label={NOTICE_COPY.upgrade.aria}
          className="flex h-10 min-w-0 items-center gap-2 rounded-lg pl-3 pr-1 hover:text-primary"
        >
          <Earth className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
          {line}
        </button>
      ) : (
        <span className="flex min-w-0 items-center gap-2 pl-3 pr-1">
          <CloudOff className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          {line}
        </span>
      )}
      <button
        type="button"
        onClick={onDismiss}
        aria-label={copy.dismiss}
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:text-hud-foreground"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}
