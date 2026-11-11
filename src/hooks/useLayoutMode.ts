/**
 * The 10-foot layout, live (P3.3; rule in src/lib/tvLayout.ts).
 *
 * Mounted once by App. Reads the rider's Settings choice and the TV media
 * query (a screen at least 1600 px wide with no fine pointer), puts
 * `data-layout="tv"` on `<html>` when it applies and keeps it in step when
 * either changes (a mouse plugged into the TV box, Settings → Layout).
 * main.tsx applies the same rule before the first paint.
 */

import { useEffect, useSyncExternalStore } from 'react';
import { applyLayout, currentLayout, tvMediaQuery, type LayoutMode } from '@/lib/tvLayout';
import { useSettingsStore } from '@/stores/settingsStore';

function subscribeTvScreen(onChange: () => void): () => void {
  const mq = typeof window === 'undefined' ? null : tvMediaQuery(window);
  mq?.addEventListener?.('change', onChange);
  return () => mq?.removeEventListener?.('change', onChange);
}

function tvScreenNow(): boolean {
  return typeof window === 'undefined' ? false : (tvMediaQuery(window)?.matches ?? false);
}

export function useLayoutMode(): LayoutMode {
  const preference = useSettingsStore((s) => s.layoutMode);
  const tvScreen = useSyncExternalStore(subscribeTvScreen, tvScreenNow, () => false);
  const mode: LayoutMode = typeof window === 'undefined' ? 'default' : currentLayout(window, preference, tvScreen);

  useEffect(() => {
    applyLayout(document.documentElement, mode);
  }, [mode]);

  return mode;
}

/** Mounts {@link useLayoutMode} (App renders it once, beside the router). */
export function LayoutModeHost(): null {
  useLayoutMode();
  return null;
}
