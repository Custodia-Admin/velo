/**
 * Window event the photoreal renderer fires when Bing imagery stalls and it
 * falls back to the OSM map (see cesiumUtils.setupBaseImagery). Lives outside
 * cesiumUtils so HUD listeners (NoTokenBanner) don't pull Cesium into the
 * ride bundle.
 */
export const IMAGERY_FALLBACK_EVENT = 'globeride:imagery-fallback';
