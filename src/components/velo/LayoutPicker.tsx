/**
 * Settings → Visual → Layout (P3.3 TV mode): Auto (the default) | TV |
 * Standard. Auto turns the TV layout on for a screen at least 1600 px wide
 * with no mouse or touchpad (rule: src/lib/tvLayout.ts); the hint says which
 * layout this screen has now. Mockup: docs/design/mockups/v2-tv-settings.html.
 */

import { useId } from 'react';
import { cn } from '@/lib/utils';
import { LAYOUT_PREFERENCES, type LayoutPreference } from '@/lib/tvLayout';
import { useLayoutMode } from '@/hooks/useLayoutMode';
import { useSettingsStore } from '@/stores/settingsStore';

const LABEL: Record<LayoutPreference, string> = {
  auto: 'Auto',
  tv: 'TV',
  default: 'Standard',
};

export function LayoutPicker() {
  const preference = useSettingsStore((s) => s.layoutMode);
  const setSettings = useSettingsStore((s) => s.setSettings);
  const mode = useLayoutMode();
  const labelId = useId();
  const hintId = useId();

  return (
    <div className="flex flex-col gap-2">
      <span id={labelId} className="sr-only">
        Layout
      </span>
      <div role="radiogroup" aria-labelledby={labelId} aria-describedby={hintId} className="flex flex-wrap gap-2">
        {LAYOUT_PREFERENCES.map((p) => {
          const active = p === preference;
          return (
            <button
              key={p}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => setSettings({ layoutMode: p })}
              className={cn(
                'h-10 rounded-pill border px-4 text-sm font-semibold transition-colors duration-150',
                active
                  ? 'border-primary bg-primary/10 text-foreground'
                  : 'border-border bg-card text-muted-foreground hover:border-primary/40 hover:text-foreground',
              )}
            >
              {LABEL[p]}
            </button>
          );
        })}
      </div>
      <span id={hintId} className="text-sm text-muted-foreground">
        {preference === 'auto'
          ? `Auto uses the TV layout on a big screen with no mouse or touchpad. On this screen: ${mode === 'tv' ? 'TV' : 'Standard'}.`
          : preference === 'tv'
            ? 'Big type and a ring you move with a remote or the handlebars.'
            : 'The laptop and tablet layout, on every screen.'}
      </span>
    </div>
  );
}
