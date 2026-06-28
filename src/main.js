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
import { parseGeoPdf } from "./geopdf.js";
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
    async loadGeoPdf(file) {
      commit({
        geopdfImport: {
          loading: true,
          error: "",
          message: `Importing ${file.name}...`
        }
      });
      try {
        const parsed = await parseGeoPdf(file);
        const overlay = {
          id: `gp-${Date.now()}`,
          name: file.name,
          visible: true,
          opacity: 0.65,
          imageDataUrl: parsed.imageDataUrl,
          coordinates: parsed.coordinates,
          boundsLngLat: parsed.boundsLngLat,
          crsCode: parsed.crsCode,
          crsLabel: parsed.crsLabel,
          width: parsed.width,
          height: parsed.height,
          pageCount: parsed.pageCount,
          transformRmse: parsed.transformRmse
        };
        const geopdfOverlays = [...(state.geopdfOverlays ?? []), overlay];
        commit({
          geopdfOverlays,
          geopdfImport: {
            loading: false,
            error: "",
            message: `Imported ${file.name}${parsed.pageCount > 1 ? " (showing page 1)." : "."}`
          }
        });
        const overlayGeometry = geoPdfOverlayToFeatureCollection(overlay);
        if (overlayGeometry.features.length) mapApi?.flyToLayer(overlayGeometry);
      } catch (err) {
        commit({
          geopdfImport: {
            loading: false,
            error: `Failed to import GeoPDF: ${err.message}`,
            message: ""
          }
        });
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
    toggleGeoPdfOverlay(id) {
      const geopdfOverlays = (state.geopdfOverlays ?? []).map((overlay) =>
        overlay.id === id ? { ...overlay, visible: !overlay.visible } : overlay
      );
      commit({ geopdfOverlays });
    },
    removeGeoPdfOverlay(id) {
      const geopdfOverlays = (state.geopdfOverlays ?? []).filter((overlay) => overlay.id !== id);
      commit({ geopdfOverlays });
    },
    zoomToGeoPdfOverlay(id) {
      const overlay = (state.geopdfOverlays ?? []).find((item) => item.id === id);
      if (!overlay) return;
      const overlayGeometry = geoPdfOverlayToFeatureCollection(overlay);
      if (overlayGeometry.features.length) mapApi?.flyToLayer(overlayGeometry);
    },
    setGeoPdfOverlayOpacity(id, opacity) {
      const nextOpacity = clamp(opacity, 0, 1);
      const geopdfOverlays = (state.geopdfOverlays ?? []).map((overlay) =>
        overlay.id === id ? { ...overlay, opacity: nextOpacity } : overlay
      );
      commit({ geopdfOverlays });
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

      const SEGMENT_COLORS = { green: "#178f48", red: "#d71920", neutral: "#2d3748" };
      const STATUS_LABELS  = {
        green:   "Adequate clearance",
        red:     "Below minimum / no lift",
        neutral: "Not assessed"
      };

      // ── 1. Harvest setting (polygon – rendered at bottom) ───────────────────
      if (state.settingPolygon) {
        features.push({
          type: "Feature",
          properties: {
            layer:           "setting",
            label:           "Harvest setting",
            "fill":          "#4f8f42",
            "fill-opacity":  0.22,
            "stroke":        "#1a8f3c",
            "stroke-width":  3,
            "stroke-opacity": 1
          },
          geometry: { type: "Polygon", coordinates: state.settingPolygon }
        });
      }

      // ── 2. User-imported layers ─────────────────────────────────────────────
      (state.userLayers ?? []).forEach((layer) => {
        (layer.geojson.features ?? []).forEach((feature) => {
          features.push({
            ...feature,
            properties: {
              ...feature.properties,
              layer:             "user_data",
              source_file:       layer.name,
              "stroke":          layer.color,
              "stroke-width":    2,
              "stroke-opacity":  0.9,
              "fill":            layer.color,
              "fill-opacity":    0.2,
              "marker-color":    layer.color
            }
          });
        });
      });

      // ── 3. Skyline corridors with result summary attributes ─────────────────
      const resultById = Object.fromEntries((state.results ?? []).map((r) => [r.id, r]));
      (state.skylines ?? []).forEach((skyline, i) => {
        const id     = skyline.id ?? String(i + 1);
        const result = resultById[id];
        features.push({
          type: "Feature",
          properties: {
            layer:              "skyline",
            skyline_id:         id,
            ...(result
              ? {
                  length_m:         Math.round(result.length),
                  deflection_pct:   Number((result.deflectionPercent || 0).toFixed(1)),
                  min_clearance_m:  Number(result.minClearance.toFixed(2)),
                  pct_adequate:     Number(result.percentGreen.toFixed(1)),
                  pct_below_min:    Number(result.percentRed.toFixed(1)),
                  pass:             result.pass
                }
              : {}),
            "stroke":           "#f8c400",
            "stroke-width":     3,
            "stroke-opacity":   0.95
          },
          geometry: { type: "LineString", coordinates: skyline.coordinates }
        });
      });

      // ── 4. Result segments – one feature per sample interval ───────────────
      // These carry the full clearance data so a GIS user can categorise by
      // status, clearance value, elevation etc.
      (state.results ?? []).forEach((result) => {
        result.samples.slice(1).forEach((sample, index) => {
          const prev = result.samples[index];
          features.push({
            type: "Feature",
            properties: {
              layer:              "result_segment",
              skyline_id:         result.id,
              status:             sample.status,
              status_label:       STATUS_LABELS[sample.status] ?? sample.status,
              clearance_m:        Number(sample.clearance.toFixed(3)),
              ground_elev_m:      Number(sample.groundElevation.toFixed(3)),
              cable_elev_m:       Number(sample.cableElevation.toFixed(3)),
              dist_along_m:       Number((sample.distanceAlongLine ?? 0).toFixed(1)),
              "stroke":           SEGMENT_COLORS[sample.status] ?? SEGMENT_COLORS.neutral,
              "stroke-width":     6,
              "stroke-opacity":   0.95
            },
            geometry: {
              type: "LineString",
              coordinates: [prev.coordinate, sample.coordinate]
            }
          });
        });
      });

      // ── 5. Skid / landing point (rendered on top) ──────────────────────────
      if (state.skid) {
        features.push({
          type: "Feature",
          properties: {
            layer:          "skid",
            label:          "Skid / Landing",
            "marker-color": "#111827",
            "marker-size":  "large",
            "marker-symbol": "circle"
          },
          geometry: { type: "Point", coordinates: state.skid }
        });
      }

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

function geoPdfOverlayToFeatureCollection(overlay) {
  const corners = (overlay?.coordinates ?? []).filter((coordinate) =>
    Array.isArray(coordinate)
    && coordinate.length >= 2
    && Number.isFinite(coordinate[0])
    && Number.isFinite(coordinate[1])
  );
  if (corners.length < 4) {
    return { type: "FeatureCollection", features: [] };
  }
  const closed = [...corners, corners[0]];
  return {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      properties: { id: overlay.id, name: overlay.name },
      geometry: {
        type: "Polygon",
        coordinates: [closed]
      }
    }]
  };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value)));
}

paint();
