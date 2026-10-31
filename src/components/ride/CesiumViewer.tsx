/**
 * Moved: the Cesium view now lives at src/renderers/cesium/CesiumWorldView.tsx
 * (the 'photoreal' renderer behind lib/world/renderer.ts). This shim keeps the
 * old import path working; new code mounts a renderer through
 * src/components/ride/RideView.tsx instead.
 */
export {
  CesiumWorldView as CesiumViewer,
  CesiumWorldView,
} from '@/renderers/cesium/CesiumWorldView';
