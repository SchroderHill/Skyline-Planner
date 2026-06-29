export const TERRAIN_MODES = {
  MAPBOX: "mapbox",
  MOCK: "mock",
  GEOTIFF: "geotiff"
};

export class MockTerrainProvider {
  constructor() {
    this.label = "mock terrain";
    this.mode = TERRAIN_MODES.MOCK;
  }

  async sampleLine(coordinates) {
    return coordinates.map(([x, y], index) => {
      const ridge = Math.sin((x + y) * 12 + index * 0.6) * 8;
      const slope = (y - coordinates[0][1]) * 120;
      return 420 + ridge + slope;
    });
  }
}

export function defaultTerrainMode(hasMapboxTerrain) {
  return hasMapboxTerrain ? TERRAIN_MODES.MAPBOX : TERRAIN_MODES.MOCK;
}

export function terrainSourceNote(mode) {
  if (mode === TERRAIN_MODES.MAPBOX) return "Terrain source: Mapbox Terrain-RGB";
  if (mode === TERRAIN_MODES.GEOTIFF) return "Terrain source: Uploaded GeoTIFF DEM";
  return "Terrain source: mock terrain — not suitable for real assessment.";
}

export function terrainWarningForMode(mode, hasMapboxTerrain) {
  if (mode === TERRAIN_MODES.MAPBOX && !hasMapboxTerrain) {
    return "Mapbox terrain is unavailable. Choose mock terrain to run a non-assessment calculation.";
  }
  if (mode === TERRAIN_MODES.MOCK) {
    return "Mock terrain is not suitable for real assessment.";
  }
  return "";
}
