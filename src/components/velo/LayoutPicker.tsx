/**
 * Settings → Visual → Layout (P3.3 TV mode): Auto (the default) | TV |
 * Standard, the same picker cards as Colours. Auto turns the TV layout on
 * for a screen at least 1600 px wide with no mouse or touchpad (rule:
 * src/lib/tvLayout.ts); the hint says which layout this screen has now.
 * Mockup: docs/design/mockups/v2-tv-settings.html.
 */

import { useId } from 'react';
import { PickerButton } from '@/components/profile/settings/shared';
import { LAYOUT_PREFERENCES, type LayoutPreference } from '@/lib/tvLayout';
import { useLayoutMode } from '@/hooks/useLayoutMode';
import { useSettingsStore } from '@/stores/settingsStore';

const OPTION: Record<LayoutPreference, { label: string; sub: string }> = {
  auto: { label: 'Auto', sub: 'by screen' },
  tv: { label: 'TV', sub: 'big type, remote' },
  default: { label: 'Standard', sub: 'laptop, tablet' },
};

export function LayoutPicker() {
  const preference = useSettingsStore((s) => s.layoutMode);
  const setSettings = useSettingsStore((s) => s.setSettings);
  const mode = useLayoutMode();
  const hintId = useId();

  return (
    <div className="flex flex-col gap-2">
      <div role="radiogroup" aria-label="Layout" aria-describedby={hintId} className="grid grid-cols-3 gap-2">
        {LAYOUT_PREFERENCES.map((p) => (
          <PickerButton
            key={p}
            radio
            selected={p === preference}
            onClick={() => setSettings({ layoutMode: p })}
            label={OPTION[p].label}
            sub={OPTION[p].sub}
          />
        ))}
      </div>
      <p id={hintId} className="text-sm text-muted-foreground">
        {preference === 'auto'
          ? `Auto picks TV on a big screen with no mouse or touchpad. This screen: ${mode === 'tv' ? 'TV' : 'Standard'}.`
          : preference === 'tv'
            ? 'TV on every screen: big type, and a ring you move with a remote or the handlebars.'
            : 'Standard on every screen, TVs too.'}
      </p>
    </div>
  );
}
