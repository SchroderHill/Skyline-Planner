export const DEFAULT_BASE_MAP_MODE = "google-satellite";

export const BASE_MAP_STYLES = Object.freeze({
  outdoors: "mapbox://styles/mapbox/outdoors-v12",
  "linz-hillshade": "mapbox://styles/mapbox/light-v11",
  "google-satellite": "mapbox://styles/mapbox/empty-v9",
  "sentinel-2": "mapbox://styles/mapbox/empty-v9"
});

export function normalizeBaseMapMode(mode) {
  return Object.hasOwn(BASE_MAP_STYLES, mode) ? mode : DEFAULT_BASE_MAP_MODE;
}

export function baseMapStyleFor(mode) {
  return BASE_MAP_STYLES[normalizeBaseMapMode(mode)];
}

export function baseMapLayerOpacity(activeMode, layerMode) {
  return normalizeBaseMapMode(activeMode) === layerMode ? 1 : 0;
}
