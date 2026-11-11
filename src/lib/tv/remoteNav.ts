/**
 * Focus navigation in the page (P3.3 TV mode): move a visible focus ring with
 * arrow keys, a TV remote or the handlebar D-pad, press what it is on, go back.
 *
 * - Scope: the topmost open modal dialog (Settings, the finish page), else
 *   the whole page; the ring never wanders behind a dialog.
 * - "Remote input": `html[data-input="remote"]` while the rider steers with
 *   keys, a remote or the handlebars (cleared by a pointer). index.css draws
 *   the focus ring for any focused control then, also when the focus moved by
 *   script (a handlebar press is no keyboard event, so :focus-visible alone
 *   would not show it).
 * - Back: a synthetic Escape at the focused control, so every open panel's own
 *   Escape handling closes it. Marked, so the ride's Escape shortcut (pause,
 *   then finish) ignores it: a back press never pauses or finishes a ride.
 */

import { nextInDirection, type Box, type Direction } from './spatialNav';

const FOCUSABLE =
  'button, [href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

/** The control a remote lands on first in a view (one per view: the filled button). */
export const NAV_PRIMARY_ATTR = 'data-nav-primary';

export function markRemoteInput(doc: Document = document): void {
  doc.documentElement.setAttribute('data-input', 'remote');
}

export function clearRemoteInput(doc: Document = document): void {
  doc.documentElement.removeAttribute('data-input');
}

export function remoteInput(doc: Document = document): boolean {
  return doc.documentElement.getAttribute('data-input') === 'remote';
}

/** Text entry and other controls that use the arrow keys themselves. */
export function usesArrowKeys(el: Element | null): boolean {
  if (!el) return false;
  const h = el as HTMLElement;
  if (h.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = ((el as HTMLInputElement).type || 'text').toLowerCase();
    return !['button', 'submit', 'reset', 'checkbox', 'image', 'file', 'color'].includes(type);
  }
  return false;
}

function isVisible(el: HTMLElement): boolean {
  if (el.getClientRects().length === 0) return false;
  const s = getComputedStyle(el);
  if (s.visibility === 'hidden' || s.visibility === 'collapse') return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

function isNavigable(el: HTMLElement): boolean {
  if ((el as HTMLButtonElement).disabled) return false;
  if (el.closest('[inert], [aria-hidden="true"]')) return false;
  // Inside a closed <details>, only its summary is on screen.
  const details = el.parentElement?.closest('details');
  if (details && !details.open && !(el.tagName === 'SUMMARY' && el.parentElement === details)) return false;
  return isVisible(el);
}

/** Where the ring may go: the topmost open modal dialog, else the page. */
export function navScope(doc: Document = document): Element {
  const dialogs = Array.from(doc.querySelectorAll<HTMLElement>('[aria-modal="true"]')).filter(isVisible);
  return dialogs[dialogs.length - 1] ?? doc.body;
}

/**
 * A modal dialog is open (Settings, the pairing guide, the finish page). Back
 * then closes the dialog, never the page under it.
 */
export function dialogOpen(doc: Document = document): boolean {
  return navScope(doc) !== doc.body;
}

export function focusablesIn(scope: Element): HTMLElement[] {
  return Array.from(scope.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(isNavigable);
}

function box(el: Element): Box {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

/** The focused control, when it is one the ring may sit on in this scope. */
export function focusedControl(doc: Document = document): HTMLElement | null {
  const el = doc.activeElement as HTMLElement | null;
  if (!el || el === doc.body || el === doc.documentElement) return null;
  const scope = navScope(doc);
  if (!scope.contains(el) || !el.matches(FOCUSABLE) || !isNavigable(el)) return null;
  return el;
}

function focus(el: HTMLElement): void {
  el.focus();
  // A control at the edge of a scrolling page comes into view (focus() alone
  // keeps it flush with the edge; a TV may crop that).
  el.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
}

/** Ring the view's primary control (else its first control). False when there is none. */
export function focusPrimary(doc: Document = document): boolean {
  const scope = navScope(doc);
  const all = focusablesIn(scope);
  const primary = all.find((el) => el.hasAttribute(NAV_PRIMARY_ATTR)) ?? all[0];
  if (!primary) return false;
  focus(primary);
  return true;
}

/**
 * Move the ring one step. With nothing ringed yet, the first press rings the
 * primary control. False at the edge (nothing that way).
 */
export function moveFocus(dir: Direction, doc: Document = document): boolean {
  const from = focusedControl(doc);
  if (!from) return focusPrimary(doc);
  const candidates = focusablesIn(navScope(doc))
    .filter((el) => el !== from && !from.contains(el) && !el.contains(from))
    .map((el) => ({ box: box(el), item: el }));
  const next = nextInDirection(box(from), candidates, dir);
  if (!next) return false;
  focus(next);
  return true;
}

/** Press the ringed control. False when nothing is ringed. */
export function activateFocused(doc: Document = document): boolean {
  const el = focusedControl(doc);
  if (!el) return false;
  el.click();
  return true;
}

const SYNTHETIC_BACK = new WeakSet<Event>();

/** True for the Escape a remote / handlebar Back sends (never pauses a ride). */
export function isNavBack(e: Event): boolean {
  return SYNTHETIC_BACK.has(e);
}

/**
 * Back: Escape at the focused control. True when something open handled it
 * (an open panel stops it before the window); false when it reached the
 * window untouched, so the caller can go back a page instead.
 */
export function sendBack(doc: Document = document): boolean {
  const win = doc.defaultView;
  if (!win) return false;
  const target = (doc.activeElement as HTMLElement | null) ?? doc.body;
  const e = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true });
  SYNTHETIC_BACK.add(e);
  let reached = false;
  const seen = (ev: Event) => {
    if (ev === e) reached = true;
  };
  win.addEventListener('keydown', seen);
  try {
    target.dispatchEvent(e);
  } finally {
    win.removeEventListener('keydown', seen);
  }
  return !reached || e.defaultPrevented;
}
