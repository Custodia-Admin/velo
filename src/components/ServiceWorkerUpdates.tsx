import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

import { notifyRouteChange } from '@/lib/swUpdate';

/**
 * Tells the service-worker updater (src/lib/swUpdate.ts) about every in-app
 * navigation: a deploy waiting since the ride started is activated, and its
 * reload happens, only once the rider is off /ride. Renders nothing.
 */
export function ServiceWorkerUpdates() {
  const { pathname } = useLocation();
  useEffect(() => {
    notifyRouteChange(pathname);
  }, [pathname]);
  return null;
}
