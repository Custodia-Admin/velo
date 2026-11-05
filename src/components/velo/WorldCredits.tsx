import { ExternalLink } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { DESTINATIONS, type Destination } from '@/lib/world/destinations';
import { creditPlaces, worldCredits } from './worldCredits';

/**
 * "Map & terrain credits": a disclosure under Home's footer line, collapsed by
 * default, listing every data source the destinations credit (name, notice,
 * licence, link) straight from their manifests. Licences such as Copernicus
 * GLO-30's (Art. 6) require the notice wherever the data reaches the public;
 * the ride HUD stays minimal, so Home is where it lives.
 */
export function WorldCredits({
  destinations = DESTINATIONS,
  className,
}: {
  destinations?: readonly Destination[];
  className?: string;
}) {
  const entries = worldCredits(destinations);
  if (entries.length === 0) return null;
  return (
    <details className={cn('group', className)} data-world-credits>
      <summary className="-mx-2 flex min-h-10 w-max cursor-pointer list-none items-center gap-2 rounded-md px-2 text-sm font-semibold text-foreground select-none hover:bg-muted/60">
        <span aria-hidden className="inline-block transition-transform duration-150 group-open:rotate-90">›</span>
        Map &amp; terrain credits
      </summary>
      <ul className="mt-2 gap-x-10 sm:columns-2">
        {entries.map(({ key, credit, places }) => (
          <li key={key} data-credit={credit.id} className="flex break-inside-avoid flex-col gap-1 border-t border-border py-3">
            <p className="text-sm font-semibold text-foreground">{credit.name}</p>
            <p className="text-sm text-muted-foreground">{credit.attribution}</p>
            <p className="text-sm text-muted-foreground">
              <span className="font-semibold text-foreground">Licence</span> {credit.licence}
            </p>
            <div className="flex flex-wrap items-center justify-between gap-x-4">
              <span className="text-xs text-muted-foreground">{creditPlaces(places, destinations.length)}</span>
              <Button asChild variant="textlink" className="px-0 font-medium">
                <a href={credit.url} target="_blank" rel="noopener noreferrer">
                  Source
                  <span className="sr-only">: {credit.name} (opens in a new tab)</span>
                  <ExternalLink className="h-4 w-4" aria-hidden />
                </a>
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </details>
  );
}
