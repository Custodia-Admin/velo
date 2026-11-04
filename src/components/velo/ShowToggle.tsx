/**
 * Ride tool that turns show mode on and off: a HUD icon button
 * (Clapperboard) in the ride tools; in show mode it is the corner close
 * button (X, "Close show mode").
 */

import { Clapperboard, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useShowStore } from '@/stores/showStore';

export function ShowToggle({ className }: { className?: string }) {
  const active = useShowStore((s) => s.active);
  const startShow = useShowStore((s) => s.startShow);
  const endShow = useShowStore((s) => s.endShow);

  return (
    <Button
      variant="hud"
      size="icon"
      aria-pressed={active}
      aria-label={active ? 'Close show mode' : 'Watch a show while you ride'}
      title={active ? 'Close show mode' : 'Ride and watch'}
      onClick={() => (active ? endShow() : startShow())}
      data-testid="show-toggle"
      className={className}
    >
      {active ? (
        <X className="h-5 w-5" aria-hidden="true" />
      ) : (
        <Clapperboard className="h-5 w-5" aria-hidden="true" />
      )}
    </Button>
  );
}
