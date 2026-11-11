/**
 * A view's primary control for remote navigation (P3.3 TV mode): spread the
 * returned props on the one filled button of a view (Home's Ride, Devices'
 * Ride, the finish page's Home). On the TV layout, or while the rider steers
 * with keys / a remote / the handlebars, the ring lands on it when the view
 * opens, so OK (Enter, handlebar A) does the obvious thing at once. The first
 * arrow press anywhere else rings it too (lib/tv/remoteNav `focusPrimary`).
 */

import { useCallback, type RefCallback } from 'react';
import { focusedControl, NAV_PRIMARY_ATTR, remoteInput } from '@/lib/tv/remoteNav';

/** True when the focus ring should land on a view's primary control by itself. */
export function remoteFirst(doc: Document = document): boolean {
  return doc.documentElement.getAttribute('data-layout') === 'tv' || remoteInput(doc);
}

export interface NavPrimaryProps<T extends HTMLElement> {
  ref: RefCallback<T>;
  [NAV_PRIMARY_ATTR]: '';
}

export function useNavPrimary<T extends HTMLElement = HTMLButtonElement>(
  { autoFocus = true }: { autoFocus?: boolean } = {},
): NavPrimaryProps<T> {
  const ref = useCallback(
    (el: T | null) => {
      if (!el || !autoFocus || typeof document === 'undefined') return;
      if (!remoteFirst() || focusedControl()) return;
      el.focus({ preventScroll: true });
    },
    [autoFocus],
  );
  return { ref, [NAV_PRIMARY_ATTR]: '' };
}
