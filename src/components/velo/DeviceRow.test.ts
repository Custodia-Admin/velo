/**
 * Device row layout (DeviceRow.tsx), read from the element tree it returns.
 * The geometry itself is measured in a browser (review probe geom.py: glyph
 * and action centre within 40 px of the title top, legend open or closed);
 * this pins the classes that produce it, so a revert to whole-row centring
 * fails here first (review of PR #27 @e675d78, R4 + N1).
 */
import { describe, expect, it } from 'vitest';
import { isValidElement, type ReactElement } from 'react';
import { Bluetooth } from 'lucide-react';
import { DeviceRow, StateDot } from './DeviceRow';
import type { RowView } from './devicesView';

type El = ReactElement<{ className?: string; children?: unknown; 'data-testid'?: string }>;

const view: RowView<'buzz' | 'disconnect'> = {
  name: 'Left handlebar · Zwift Ride',
  tone: 'ok',
  state: 'Connected · gears and buttons',
  help: null,
  action: { id: 'buzz', label: 'Test buzz' },
  extras: [{ id: 'disconnect', label: 'Disconnect' }],
};

function kids(el: El): El[] {
  const c = el.props.children;
  return (Array.isArray(c) ? c.flat() : [c]).filter((x): x is El => isValidElement(x));
}

function row(): El {
  return DeviceRow({ icon: Bluetooth, view, onAction: () => undefined, testId: 'device-handlebar' }) as El;
}

describe('DeviceRow layout', () => {
  it('top-aligns its cells: a tall row (legend open) keeps the glyph and the action level with the name', () => {
    const root = row();
    const cls = root.props.className!.split(/\s+/);
    expect(cls).toContain('items-start');
    expect(cls).not.toContain('items-center');
    const [glyph, , action] = kids(root);
    // mt-1 centres the h-10 glyph / action on the name + state lines.
    expect(glyph.props.className!.split(/\s+/)).toEqual(expect.arrayContaining(['mt-1', 'h-10']));
    expect(action.props.className!.split(/\s+/)).toContain('sm:mt-1');
  });

  it('the state wraps beside the dot (hanging indent), so a wrapped line never strands the dot', () => {
    const [, text] = kids(row());
    const status = kids(text).find((k) => (k.props as { role?: string }).role === 'status')!;
    const cls = status.props.className!.split(/\s+/);
    expect(cls).toContain('items-start');
    expect(cls).not.toContain('flex-wrap');
    const [dot, sentence] = kids(status);
    expect(dot.type).toBe(StateDot);
    expect(sentence.props.className).toContain('min-w-0');
    expect(textOf(sentence)).toContain(view.state);
  });
});

function textOf(node: unknown): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  return isValidElement(node) ? textOf((node.props as { children?: unknown }).children) : '';
}
