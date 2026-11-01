/**
 * Field diagnostics for the handlebar controls, inside the ride view: the
 * last few raw messages (hex) with their parsed reading and the gear they
 * caused, plus the link state. Off unless switched on in Home → Trainer
 * ("Controller debug") or opened with ?ctrldebug=1. Sized to fit one phone
 * screenshot.
 */

import { useState, useSyncExternalStore } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { HUD_PANEL } from './v2';
import { controllerDebug, getDebugEntries, subscribeDebug } from '@/lib/controllers/rideController';
import { controllerPhase } from '@/lib/controllers/controllerView';
import { useControllerStore } from '@/stores/controllerStore';

function urlAsksForDebug(): boolean {
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).get('ctrldebug') === '1';
}

const noopSubscribe = () => () => undefined;
const PHONE_LINES = 6;

/** True when the overlay is on (setting or ?ctrldebug=1). */
export function useControllerDebugVisible(): boolean {
  const enabled = useControllerStore((s) => s.debugOverlay);
  const fromUrl = useSyncExternalStore(noopSubscribe, urlAsksForDebug, () => false);
  return enabled || fromUrl;
}

export function ControllerDebugOverlay() {
  const visible = useControllerDebugVisible();
  const entries = useSyncExternalStore(subscribeDebug, getDebugEntries, getDebugEntries);
  const status = useControllerStore((s) => s.status);
  const silent = useControllerStore((s) => s.silent);
  const side = useControllerStore((s) => s.side);
  const inputSeen = useControllerStore((s) => s.inputSeen);
  const battery = useControllerStore((s) => s.battery);
  const buzz = useControllerStore((s) => s.buzz);
  const gear = useControllerStore((s) => s.gear);
  const deviceName = useControllerStore((s) => s.deviceName);
  const [copied, setCopied] = useState(false);

  if (!visible) return null;

  const phase = controllerPhase({ status, silent, side, inputSeen });
  const facts = [
    `phase ${phase}`,
    `side ${side ?? '–'}`,
    `battery ${battery === null ? '–' : `${battery} %`}`,
    `buzz ${buzz ?? '–'}`,
    `input ${inputSeen ? 'yes' : 'none yet'}`,
    `gear ${gear}`,
  ];

  const copy = () => {
    const text = [`${deviceName ?? 'no device'} · ${facts.join(' · ')}`, ...controllerDebug.lines()].join('\n');
    void navigator.clipboard?.writeText(text).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  };

  return (
    <div className={cn(HUD_PANEL, 'pointer-events-auto flex w-full max-w-sm flex-col gap-2 px-4 py-3')} role="group" aria-label="Controller debug">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Controller debug</span>
        <Button variant="ghost" size="sm" className="h-10" onClick={copy}>
          {copied ? 'Copied' : 'Copy log'}
        </Button>
      </div>
      <p className="font-mono text-xs text-foreground">
        {deviceName ?? 'no device'} · {facts.join(' · ')}
      </p>
      {entries.length === 0 ? (
        <p className="text-xs text-muted-foreground">No messages yet.</p>
      ) : (
        <ol className="flex flex-col gap-1 font-mono text-xs" aria-label="Last controller messages">
          {entries.map((e, i) => (
            // Phones keep the last PHONE_LINES so the card clears the ride controls.
            <li key={e.id} className={cn('flex-col', i < entries.length - PHONE_LINES ? 'hidden sm:flex' : 'flex')}>
              <span className="break-all text-muted-foreground">
                {e.time.slice(3)} {e.dir === 'in' ? '←' : '→'} {e.hex}
                {e.count > 1 ? ` ×${e.count}` : ''}
              </span>
              <span className="text-foreground">{e.note}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
