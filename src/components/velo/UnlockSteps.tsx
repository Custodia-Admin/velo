/**
 * The daily unlock recipe for the handlebar controls, as a short ordered
 * list. Used by the Trainer panel and the in-ride chip.
 */

import { UNLOCK_STEPS } from '@/lib/controllers/controllerView';

export function UnlockSteps({ intro }: { intro: string }) {
  return (
    <div className="flex max-w-prose flex-col gap-2 text-sm text-foreground" role="status">
      <p>{intro}</p>
      <ol className="flex list-decimal flex-col gap-1 pl-5 text-muted-foreground">
        {UNLOCK_STEPS.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
    </div>
  );
}
