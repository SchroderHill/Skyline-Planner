import "./styles.css";
import { calculateProject } from "./clearance.js";
import { createMap } from "./map.js";
import { printReport } from "./report.js";
import { createInitialState, clearState, loadState, saveState } from "./state.js";
import {
  MockTerrainProvider,
  TERRAIN_MODES,
  defaultTerrainMode,
  terrainSourceNote,
  terrainWarningForMode
} from "./terrain.js";
import { GeoTiffTerrainProvider } from "./geotiff-terrain.js";
import { parseKml, parseShapefile, nextLayerColor } from "./user-layers.js";
import { renderApp } from "./ui.js";

// Cache basemap tiles (Google, LINZ, Sentinel-2) in the browser for fast repeat loads
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

const root = document.querySelector("#app");
const mockTerrainProvider = new MockTerrainProvider();
const geotiffTerrainProvider = new GeoTiffTerrainProvider();
let state = loadState();
state.terrainMode ??= defaultTerrainMode(Boolean(import.meta.env.VITE_MAPBOX_TOKEN));
state.terrainStatus ??= terrainStatusFor(state.terrainMode);
let mapApi;
state = withSequentialSkylineIds(state);

function commit(patch) {
  state = withSequentialSkylineIds({ ...state, ...patch });
  saveState(state);
  paint();
}

function paint() {
  renderApp(root, state, {
    rename(projectName) {
      state.projectName = projectName;
      saveState(state);
    },
    saveAssumptions(assumptions) {
      commit({ assumptions: normalizeAssumptions(assumptions) });
    },
    changeTerrainMode(terrainMode) {
      commit({
        terrainMode,
        results: [],
        terrainStatus: terrainStatusFor(terrainMode),
        // Clear any previous GeoTIFF state when switching modes
        geotiffMeta: terrainMode === TERRAIN_MODES.GEOTIFF ? state.geotiffMeta : null,
        geotiffError: null,
      });
    },
    async loadGeoTiff(file) {
      commit({ geotiffMeta: null, geotiffError: null, results: [] });
      try {
        const meta = await geotiffTerrainProvider.loadFile(file);
        commit({
          geotiffMeta: meta,
          geotiffError: null,
          terrainStatus: {
            source: terrainSourceNote(TERRAIN_MODES.GEOTIFF),
            warning: ""
          }
        });
      } catch (err) {
        commit({
          geotiffMeta: null,
          geotiffError: err.message,
          terrainStatus: {
            source: terrainSourceNote(TERRAIN_MODES.GEOTIFF),
            warning: err.message
          }
        });
      }
    },
    async loadKml(file) {
      try {
        const geojson = await parseKml(file);
        const layer = {
          id: `ul-${Date.now()}`,
          name: file.name,
          type: "kml",
          geojson,
          visible: true,
          color: nextLayerColor()
        };
        const userLayers = [...(state.userLayers ?? []), layer];
        commit({ userLayers });
        mapApi?.flyToLayer(geojson);
      } catch (err) {
        window.alert(`Failed to import KML: ${err.message}`);
      }
    },
    async loadShapefile(file) {
      try {
        const geojson = await parseShapefile(file);
        const layer = {
          id: `ul-${Date.now()}`,
          name: file.name,
          type: "shapefile",
          geojson,
          visible: true,
          color: nextLayerColor()
        };
        const userLayers = [...(state.userLayers ?? []), layer];
        commit({ userLayers });
        mapApi?.flyToLayer(geojson);
      } catch (err) {
        window.alert(`Failed to import shapefile: ${err.message}`);
      }
    },
    toggleUserLayer(id) {
      const userLayers = (state.userLayers ?? []).map((l) =>
        l.id === id ? { ...l, visible: !l.visible } : l
      );
      commit({ userLayers });
    },
    removeUserLayer(id) {
      const userLayers = (state.userLayers ?? []).filter((l) => l.id !== id);
      commit({ userLayers });
    },
    zoomToUserLayer(id) {
      const layer = (state.userLayers ?? []).find((l) => l.id === id);
      if (layer) mapApi?.flyToLayer(layer.geojson);
    },
    changeBaseMapMode(baseMapMode) {
      commit({ baseMapMode });
    },
    async calculate() {
      mapApi?.blur();
      if (!state.skylines.length) {
        window.alert("Draw or load at least one skyline first.");
        return;
      }
      const provider = selectedTerrainProvider();
      if (!provider) {
        const warning = state.terrainMode === TERRAIN_MODES.GEOTIFF
          ? "No GeoTIFF DEM loaded. Upload a .tif file above, then recalculate."
          : "Mapbox terrain is not ready or did not load. Choose mock terrain to run a non-assessment calculation.";
        commit({ terrainStatus: { source: terrainSourceNote(state.terrainMode), warning } });
        return;
      }

      try {
        const calculationState = withSequentialSkylineIds(state);
        const results = await calculateProject(calculationState.skylines, calculationState.assumptions, provider);
        commit({
          results,
          terrainStatus: {
            source: terrainSourceNote(provider.mode),
            warning: terrainWarningForMode(provider.mode, mapApi?.hasTerrain?.())
          }
        });
      } catch (error) {
        commit({
          results: [],
          terrainStatus: {
            source: terrainSourceNote(state.terrainMode),
            warning: `${error.message} Choose mock terrain to run a non-assessment calculation.`
          }
        });
      }
    },
    edit() {
      mapApi?.blur();
      mapApi?.edit();
    },
    async print() {
      mapApi?.blur();
      const mapImage = await mapApi?.captureImage?.(state);
      printReport(state, { mapImage });
    },
    exportGeoJson() {
      mapApi?.blur();
      const features = [];
      if (state.skid) {
        features.push({
          type: "Feature",
          properties: { type: "skid" },
          geometry: { type: "Point", coordinates: state.skid }
        });
      }
      if (state.settingPolygon) {
        features.push({
          type: "Feature",
          properties: { type: "setting" },
          geometry: { type: "Polygon", coordinates: state.settingPolygon }
        });
      }
      (state.skylines ?? []).forEach((skyline, i) => {
        features.push({
          type: "Feature",
          properties: { type: "skyline", id: skyline.id ?? String(i + 1) },
          geometry: { type: "LineString", coordinates: skyline.coordinates }
        });
      });
      if (!features.length) {
        window.alert("Nothing to export — draw some geometry first.");
        return;
      }
      const geojson = JSON.stringify({ type: "FeatureCollection", features }, null, 2);
      const blob = new Blob([geojson], { type: "application/geo+json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${state.projectName || "skyline-project"}.geojson`;
      a.click();
      URL.revokeObjectURL(url);
    },
    reset() {
      mapApi?.blur();
      if (window.confirm("Reset the project? This clears geometry, assumptions, and results.")) {
        clearState();
        state = createInitialState();
        paint();
        mapApi?.syncDraw(state);
      }
    }
  });

  if (!mapApi) {
    const mapContainer = document.querySelector("#map");
    mapApi = createMap(mapContainer, state, (geometry) => {
      commit({ ...geometry, results: [] });
    });
  } else {
    mapApi.render(state);
  }
}

function withSequentialSkylineIds(project) {
  const skylines = (project.skylines ?? []).map((skyline, index) => ({
    ...skyline,
    id: String(index + 1)
  }));
  const results = (project.results ?? []).map((result, index) => ({
    ...result,
    id: String(index + 1)
  }));
  return { ...project, skylines, results };
}

function selectedTerrainProvider() {
  if (state.terrainMode === TERRAIN_MODES.MOCK) return mockTerrainProvider;
  if (state.terrainMode === TERRAIN_MODES.GEOTIFF) {
    return geotiffTerrainProvider._ready ? geotiffTerrainProvider : null;
  }
  return mapApi?.getTerrainProvider?.() ?? null;
}

function terrainStatusFor(terrainMode) {
  const hasTerrain = terrainMode === TERRAIN_MODES.MAPBOX
    ? Boolean(import.meta.env.VITE_MAPBOX_TOKEN)
    : false;
  return {
    source: terrainSourceNote(terrainMode),
    warning: terrainWarningForMode(terrainMode, hasTerrain)
  };
}

function normalizeAssumptions(assumptions) {
  const landingTowerHeight = assumptions.landingTowerPreset === "custom"
    ? Number(assumptions.landingTowerHeight)
    : feetToMetres(Number(assumptions.landingTowerPreset));

  return {
    ...assumptions,
    landingTowerHeight,
    tailholdHeight: Number(assumptions.tailholdHeight),
    minimumClearance: Number(assumptions.minimumClearance),
    manualSagAllowance: Number(assumptions.manualSagAllowance),
    deflectionPercent: Number(assumptions.deflectionPercent),
    sampleSpacing: Number(assumptions.sampleSpacing)
  };
}

function feetToMetres(feet) {
  return Number.isFinite(feet) ? feet * 0.3048 : 0;
}

paint();
