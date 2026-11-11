import React, { Suspense } from 'react';
import { BrowserRouter, Route, Routes, Navigate } from 'react-router-dom';

import { Home } from '@/routes/Home';
import { Toaster } from '@/components/setup/Toaster';
import { TrainerEventBridge } from '@/components/trainer/TrainerEventBridge';
import { ServiceWorkerUpdates } from '@/components/ServiceWorkerUpdates';
import { RouteErrorBoundary } from '@/components/RouteErrorBoundary';
import { LayoutModeHost } from '@/hooks/useLayoutMode';
import { RemoteNavigationHost } from '@/hooks/useRemoteNavigation';

const Ride = React.lazy(() => import('@/routes/Ride').then(m => ({ default: m.Ride })));
const Devices = React.lazy(() => import('@/routes/Devices').then(m => ({ default: m.Devices })));

function LoadingFallback() {
  return (
    <div className="fixed inset-0 flex items-center justify-center bg-background">
      <div className="h-8 w-8 rounded-full border-2 border-accent border-t-transparent animate-spin" />
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <TrainerEventBridge />
      <ServiceWorkerUpdates />
      <LayoutModeHost />
      {/* Arrow keys / TV remote / handlebar buttons move a visible focus ring (P3.3). */}
      <RemoteNavigationHost />
      <Suspense fallback={<LoadingFallback />}>
        <Routes>
          {/* Home is the app: "/" (and any unknown URL, below) goes there */}
          <Route path="/" element={<Navigate to="/app" replace />} />
          {/* Ride-setup app */}
          <Route path="/app" element={<RouteErrorBoundary routeName="Home"><Home /></RouteErrorBoundary>} />
          {/* Pair the trainer, handlebar controls and heart-rate strap */}
          <Route path="/devices" element={<RouteErrorBoundary routeName="Devices"><Suspense fallback={<LoadingFallback />}><Devices /></Suspense></RouteErrorBoundary>} />
          <Route path="/ride" element={<RouteErrorBoundary routeName="Ride"><Suspense fallback={<LoadingFallback />}><Ride /></Suspense></RouteErrorBoundary>} />
          <Route path="*" element={<Navigate to="/app" replace />} />
        </Routes>
      </Suspense>
      <Toaster />
    </BrowserRouter>
  );
}
