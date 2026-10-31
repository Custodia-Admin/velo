/**
 * Ride top-bar button that turns show mode on and off.
 */

import { Tv } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useShowStore } from '@/stores/showStore';

export function ShowToggle({ className }: { className?: string }) {
  const active = useShowStore((s) => s.active);
  const startShow = useShowStore((s) => s.startShow);
  const endShow = useShowStore((s) => s.endShow);

  return (
    <Button
      variant="outline"
      aria-pressed={active}
      aria-label={active ? 'Turn off show mode' : 'Watch a show while you ride'}
      onClick={() => (active ? endShow() : startShow())}
      data-testid="show-toggle"
      className={cn(
        'h-10 rounded-pill px-3 glass glass-hairline sm:px-4',
        active ? 'border-primary bg-primary/15 text-primary' : 'border-transparent',
        className,
      )}
    >
      <Tv className="h-4 w-4" />
      <span className="hidden sm:inline">Show</span>
    </Button>
  );
}
