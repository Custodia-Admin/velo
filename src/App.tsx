import React, { Suspense } from 'react';
import { BrowserRouter, Route, Routes, Navigate, useLocation } from 'react-router-dom';

import { Home } from '@/routes/Home';
import { StravaCallback } from '@/routes/StravaCallback';
import { Toaster } from '@/components/setup/Toaster';
import { TrainerEventBridge } from '@/components/trainer/TrainerEventBridge';
import { Onboarding } from '@/components/profile/Onboarding';
import { AchievementToast } from '@/components/ride/AchievementToast';
import { RouteErrorBoundary } from '@/components/RouteErrorBoundary';

const Ride = React.lazy(() => import('@/routes/Ride').then(m => ({ default: m.Ride })));
const Replay = React.lazy(() => import('@/routes/Replay').then(m => ({ default: m.Replay })));
const Devices = React.lazy(() => import('@/routes/Devices').then(m => ({ default: m.Devices })));

function LoadingFallback() {
  return (
    <div className="fixed inset-0 flex items-center justify-center bg-background">
      <div className="h-8 w-8 rounded-full border-2 border-accent border-t-transparent animate-spin" />
    </div>
  );
}

function AppLaunchOnboarding() {
  const location = useLocation();
  if (location.pathname === '/') return null;
  return <Onboarding />;
}

export default function App() {
  return (
    <BrowserRouter>
      <TrainerEventBridge />
      <Suspense fallback={<LoadingFallback />}>
        <Routes>
          {/* Home is the app: "/" (and any unknown URL, below) goes there */}
          <Route path="/" element={<Navigate to="/app" replace />} />
          {/* Ride-setup app */}
          <Route path="/app" element={<RouteErrorBoundary routeName="Home"><Home /></RouteErrorBoundary>} />
          {/* Pair the trainer, handlebar controls and heart-rate strap */}
          <Route path="/devices" element={<RouteErrorBoundary routeName="Devices"><Suspense fallback={<LoadingFallback />}><Devices /></Suspense></RouteErrorBoundary>} />
          <Route path="/ride" element={<RouteErrorBoundary routeName="Ride"><Suspense fallback={<LoadingFallback />}><Ride /></Suspense></RouteErrorBoundary>} />
          {/* Cinematic replay */}
          <Route path="/replay/:rideId" element={<RouteErrorBoundary routeName="Replay"><Suspense fallback={<LoadingFallback />}><Replay /></Suspense></RouteErrorBoundary>} />
          {/* Strava OAuth callback — auto-captures ?code= after user approves */}
          <Route path="/strava-callback" element={<RouteErrorBoundary routeName="Strava Callback"><StravaCallback /></RouteErrorBoundary>} />
          <Route path="*" element={<Navigate to="/app" replace />} />
        </Routes>
      </Suspense>
      <Toaster />
      <AppLaunchOnboarding />
      <AchievementToast />
    </BrowserRouter>
  );
}
