import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from '@/App';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { silenceKnownWarnings } from '@/lib/silenceKnownWarnings';
import { warnIfTokenMissing } from '@/lib/cesiumTokenWarning';
import { perfOverlayEnabled } from '@/lib/perf/perfFlag';
import { installTvLayout } from '@/lib/tvLayout';
import { startServiceWorker } from '@/lib/swUpdate';
import '@/index.css';
// Side-effect import ensures the theme is applied as early as the module
// graph loads, in addition to the pre-paint script in index.html.
import '@/stores/themeStore';

// Drop the Recharts "width(0) height(0)" warning flood — see helper docstring.
silenceKnownWarnings();

// Remember ?perf=1 (ride perf overlay) before the router drops the query.
perfOverlayEnabled();

// 10-foot layout (1rem = 28 px) on a TV browser, or with ?layout=tv.
installTvLayout();

// Dev-only warning if VITE_CESIUM_ION_TOKEN is missing.
warnIfTokenMissing();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);

// Offline support + updates. A new deploy waits while the rider is on /ride
// and takes over (one reload) on the next navigation off it: a deploy never
// reloads a ride (src/lib/swUpdate.ts). Production only: dev builds no worker.
if (import.meta.env.PROD) startServiceWorker();
