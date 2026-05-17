import mapboxgl from "mapbox-gl";
import MapboxDraw from "@mapbox/mapbox-gl-draw";
import "mapbox-gl/dist/mapbox-gl.css";
import "@mapbox/mapbox-gl-draw/dist/mapbox-gl-draw.css";
import { distance } from "./clearance.js";
import { formatArea, polygonAreaSquareMetres, polygonCentroid } from "./geometry.js";
import { MapboxTerrainProvider } from "./terrain.js";

export const DEFAULT_MAP_VIEW = {
  center: [173.52, -41.25],
  zoom: 10.5
};

const COLORS = { green: "#178f48", red: "#d71920", neutral: "#2d3748" };
const SOURCE_IDS = {
  linzHillshade: "linz-hillshade-overlay",
  googleSatellite: "google-satellite-overlay",
  sentinel2: "sentinel2-overlay",
  linzParcels: "linz-parcels",
  setting: "setting-overlay",
  skid: "skid-overlay",
  corridors: "corridor-base",
  results: "result-segments",
  labels: "skyline-labels",
  vertexPulse: "vertex-pulse",
  geotiffFootprint: "geotiff-footprint"
};
const LAYER_IDS = {
  linzHillshade: "linz-hillshade-overlay-layer",
  googleSatellite: "google-satellite-overlay-layer",
  sentinel2: "sentinel2-overlay-layer",
  linzParcelsFill: "linz-parcels-fill",
  linzParcelsLine: "linz-parcels-line",
  linzParcelsLabel: "linz-parcels-label"
};
const TERRAIN_SOURCE_ID = "mapbox-terrain-dem";
const STYLES = {
  outdoors: "mapbox://styles/mapbox/outdoors-v12",
  "linz-hillshade": "mapbox://styles/mapbox/light-v11",
  "google-satellite": "mapbox://styles/mapbox/empty-v9",
  "sentinel-2": "mapbox://styles/mapbox/empty-v9"
};

export function createMap(container, state, onGeometryChange) {
  const token = import.meta.env.VITE_MAPBOX_TOKEN;
  const linzApiKey = import.meta.env.VITE_LINZ_API_KEY;
  const linzLdsKey = import.meta.env.VITE_LINZ_LDS_KEY;
  const sentinelInstanceId = import.meta.env.VITE_SENTINEL_INSTANCE_ID;
  if (!token) return createFallbackMap(container, state, onGeometryChange);

  let currentState = state;
  let currentBaseStyle = STYLES[state.baseMapMode] ?? STYLES.outdoors;
  let styleLoading = false;
  let pendingDrawMode = null;
  mapboxgl.accessToken = token;
  const map = new mapboxgl.Map({
    container,
    style: currentBaseStyle,
    center: DEFAULT_MAP_VIEW.center,
    zoom: DEFAULT_MAP_VIEW.zoom,
    preserveDrawingBuffer: true,
    maxTileCacheZoomLevels: 20  // keep tiles cached across more zoom levels in-session
  });
  const draw = new MapboxDraw({
    displayControlsDefault: false,
    controls: { point: true, polygon: true, line_string: true, trash: true }
  });

  map.addControl(new mapboxgl.NavigationControl(), "top-right");
  map.addControl(draw, "top-left");
  renameDrawControls(container);
  addLegend(container);

  const loadingOverlay = document.createElement("div");
  loadingOverlay.className = "sentinel-loading";
  loadingOverlay.innerHTML = `
    <div class="sentinel-loading__inner">
      <svg class="sentinel-loading__spinner" viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="32" stroke-dashoffset="12"/>
      </svg>
      <span>Loading Sentinel-2 imagery&hellip;</span>
      <small>Fetching least-cloudy scenes (&lt;5% cloud) from the last 90 days</small>
    </div>
  `;
  container.appendChild(loadingOverlay);

  let sentinelLoadingDone = false;
  let sentinelLoadingTimer = null;

  function hideSentinelOverlay() {
    sentinelLoadingDone = true;
    clearTimeout(sentinelLoadingTimer);
    sentinelLoadingTimer = null;
    loadingOverlay.classList.remove("sentinel-loading--visible");
  }

  map.on("sourcedataloading", (e) => {
    if (!sentinelLoadingDone && e.sourceId === SOURCE_IDS.sentinel2 && currentState.baseMapMode === "sentinel-2") {
      loadingOverlay.classList.add("sentinel-loading--visible");
      if (!sentinelLoadingTimer) {
        sentinelLoadingTimer = setTimeout(hideSentinelOverlay, 7000);
      }
    }
  });
  map.on("idle", () => {
    if (loadingOverlay.classList.contains("sentinel-loading--visible")) {
      hideSentinelOverlay();
    }
  });
  map.on("error", () => {
    if (loadingOverlay.classList.contains("sentinel-loading--visible")) {
      hideSentinelOverlay();
    }
  });

  function styleDrawVertices() {
    // Make MapboxDraw's vertex dots larger and clearly styled (white circle, green border)
    const vertexDotLayers = [
      "gl-draw-polygon-and-line-vertex-inactive.cold",
      "gl-draw-polygon-and-line-vertex-inactive.hot",
    ];
    const vertexHaloLayers = [
      "gl-draw-polygon-and-line-vertex-stroke-inactive.cold",
      "gl-draw-polygon-and-line-vertex-stroke-inactive.hot",
    ];
    vertexDotLayers.forEach((id) => {
      if (map.getLayer(id)) {
        map.setPaintProperty(id, "circle-radius", 6);
        map.setPaintProperty(id, "circle-color", "#ffffff");
      }
    });
    vertexHaloLayers.forEach((id) => {
      if (map.getLayer(id)) {
        map.setPaintProperty(id, "circle-radius", 10);
        map.setPaintProperty(id, "circle-color", "#1a8f3c");
      }
    });
  }

  // --- User layer tracking ---
  // Keeps track of which user layer IDs have been added to the map.
  // Must be cleared whenever the style reloads (all sources are wiped).
  const userLayerIds = new Set();

  function addUserLayerToMap(layer) {
    const sourceId = `user-layer-${layer.id}`;
    if (map.getSource(sourceId)) return;
    map.addSource(sourceId, {
      type: "geojson",
      data: layer.visible ? layer.geojson : emptyCollection()
    });
    const color = layer.color ?? "#3B82F6";
    map.addLayer({
      id: `${sourceId}-fill`,
      type: "fill",
      source: sourceId,
      filter: ["==", ["geometry-type"], "Polygon"],
      paint: { "fill-color": color, "fill-opacity": 0.2 }
    });
    map.addLayer({
      id: `${sourceId}-line`,
      type: "line",
      source: sourceId,
      filter: ["any", ["==", ["geometry-type"], "LineString"], ["==", ["geometry-type"], "Polygon"]],
      paint: { "line-color": color, "line-width": 2, "line-opacity": 0.9 }
    });
    map.addLayer({
      id: `${sourceId}-circle`,
      type: "circle",
      source: sourceId,
      filter: ["==", ["geometry-type"], "Point"],
      paint: {
        "circle-color": color,
        "circle-radius": 5,
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": 1.5
      }
    });
    userLayerIds.add(layer.id);
  }

  function removeUserLayerFromMap(layerId) {
    const sourceId = `user-layer-${layerId}`;
    [`${sourceId}-fill`, `${sourceId}-line`, `${sourceId}-circle`].forEach((id) => {
      if (map.getLayer(id)) map.removeLayer(id);
    });
    if (map.getSource(sourceId)) map.removeSource(sourceId);
    userLayerIds.delete(layerId);
  }

  function syncUserLayers(state) {
    const layers = state.userLayers ?? [];
    const stateIds = new Set(layers.map((l) => l.id));
    // Remove layers no longer in state
    for (const id of [...userLayerIds]) {
      if (!stateIds.has(id)) removeUserLayerFromMap(id);
    }
    // Add new layers; update data for existing ones
    for (const layer of layers) {
      const sourceId = `user-layer-${layer.id}`;
      if (!map.getSource(sourceId)) {
        addUserLayerToMap(layer);
      } else {
        map.getSource(sourceId).setData(layer.visible ? layer.geojson : emptyCollection());
      }
    }
  }

  function initStyleLayers() {
    styleLoading = false;
    userLayerIds.clear(); // style reload wipes all sources
    addBaseMapLayers(map, linzApiKey, sentinelInstanceId, currentState.baseMapMode);
    addTerrainSource(map);
    addParcelLayer(map);
    restoreDrawFeatures(draw, currentState);
    addProjectLayers(map);
    renderProjectMap(map, currentState);
    syncUserLayers(currentState);
    fetchParcels(map, linzLdsKey);
    styleDrawVertices();
    if (pendingDrawMode) {
      const modeToRestore = pendingDrawMode;
      pendingDrawMode = null;
      // Defer slightly so draw control finishes its own style.load handler first
      setTimeout(() => draw.changeMode(modeToRestore), 0);
    }
  }

  map.on("load", initStyleLayers);
  map.on("moveend", () => fetchParcels(map, linzLdsKey));

  // Disable double-click zoom so it never conflicts with editing features.
  // Users can still zoom with scroll, pinch, or the +/- navigation buttons.
  map.doubleClickZoom.disable();

  // --- Pulsing vertex animation ---
  let pulseAnimId = null;

  function updatePulseVertices(feature) {
    if (!map.getSource(SOURCE_IDS.vertexPulse)) return;
    const raw = feature.geometry.type === "LineString"
      ? feature.geometry.coordinates
      : feature.geometry.coordinates[0].slice(0, -1); // drop closing duplicate
    map.getSource(SOURCE_IDS.vertexPulse).setData({
      type: "FeatureCollection",
      features: raw.map((c) => ({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: c } }))
    });
  }

  function startPulse() {
    if (pulseAnimId) return;
    const t0 = performance.now();
    function frame(now) {
      const t = ((now - t0) % 1500) / 1500;  // 1.5 s cycle
      const radius = 8 + t * 26;             // expand 8 → 34 px
      const opacity = 0.65 * (1 - t);        // fade out
      if (map.getLayer("vertex-pulse-ring")) {
        map.setPaintProperty("vertex-pulse-ring", "circle-radius", radius);
        map.setPaintProperty("vertex-pulse-ring", "circle-opacity", opacity);
      }
      pulseAnimId = requestAnimationFrame(frame);
    }
    pulseAnimId = requestAnimationFrame(frame);
  }

  function stopPulse() {
    if (pulseAnimId) {
      cancelAnimationFrame(pulseAnimId);
      pulseAnimId = null;
    }
    if (map.getSource(SOURCE_IDS.vertexPulse)) {
      map.getSource(SOURCE_IDS.vertexPulse).setData(emptyCollection());
    }
    if (map.getLayer("vertex-pulse-ring")) {
      map.setPaintProperty("vertex-pulse-ring", "circle-opacity", 0);
    }
  }

  // As soon as a line or polygon is selected, jump straight into vertex-edit
  // (direct_select) mode and start the pulse so edit state is unmistakable.
  map.on("draw.selectionchange", (e) => {
    if (isBlurring) return;  // don't fight back against blur()
    const feature = e.features?.[0];
    if (!feature) {
      stopPulse();
      return;
    }
    if (feature.geometry.type === "LineString" || feature.geometry.type === "Polygon") {
      if (draw.getMode() === "simple_select") {
        draw.changeMode("direct_select", { featureId: feature.id });
      }
      updatePulseVertices(feature);
      startPulse();
    } else {
      stopPulse();
    }
  });

  // Stop pulsing when the user switches to a draw tool or deselects everything
  map.on("draw.modechange", (e) => {
    if (e.mode !== "direct_select") stopPulse();
  });

  // When in direct_select, check whether the click landed on a draw vertex/midpoint.
  // If not (i.e. empty map space), exit to simple_select so drag-to-pan works normally.
  // If it did land on a draw feature, just stop the pulse so the vertex can be dragged.
  map.on("mousedown", (e) => {
    if (draw.getMode() !== "direct_select") return;
    stopPulse();
    const drawFeatures = map.queryRenderedFeatures(e.point).filter(
      (f) => f.source && f.source.startsWith("mapbox-gl-draw")
    );
    if (drawFeatures.length === 0) {
      isBlurring = true;
      try {
        draw.changeMode("simple_select");
      } finally {
        isBlurring = false;
      }
    }
  });
  map.on("touchstart", () => {
    if (draw.getMode() === "direct_select") stopPulse();
  });

  let isSnapping = false;
  let isBlurring = false;
  ["draw.create", "draw.update", "draw.delete"].forEach((eventName) => {
    map.on(eventName, () => {
      if (isSnapping || isBlurring) return;
      if (eventName !== "draw.delete") {
        isSnapping = true;
        try {
          snapLinesToSkid(draw);
        } finally {
          isSnapping = false;
        }
      } else {
        stopPulse();
      }
      onGeometryChange(readDrawFeatures(draw));
    });
  });

  return {
    render(nextState) {
      currentState = nextState;
      const newStyle = STYLES[currentState.baseMapMode] ?? STYLES.outdoors;
      if (newStyle !== currentBaseStyle) {
        currentBaseStyle = newStyle;
        styleLoading = true;
        sentinelLoadingDone = false;
        clearTimeout(sentinelLoadingTimer);
        sentinelLoadingTimer = null;
        const activeMode = draw.getMode();
        if (activeMode.startsWith("draw_")) pendingDrawMode = activeMode;
        map.setStyle(newStyle);
        map.once("style.load", initStyleLayers);
      } else if (!styleLoading) {
        renderProjectMap(map, currentState);
        syncUserLayers(currentState);
      }
    },
    syncDraw(nextState) {
      currentState = nextState;
      if (map.loaded() && !styleLoading) {
        restoreDrawFeatures(draw, currentState);
        renderProjectMap(map, currentState);
        syncUserLayers(currentState);
      }
    },
    flyToLayer(geojson) {
      // Compute bounding box of all coordinates in the GeoJSON and fly to it.
      const coords = [];
      const collect = (geometry) => {
        if (!geometry) return;
        if (geometry.type === "Point") {
          coords.push(geometry.coordinates);
        } else if (geometry.type === "MultiPoint" || geometry.type === "LineString") {
          coords.push(...geometry.coordinates);
        } else if (geometry.type === "MultiLineString" || geometry.type === "Polygon") {
          geometry.coordinates.forEach((ring) => coords.push(...ring));
        } else if (geometry.type === "MultiPolygon") {
          geometry.coordinates.forEach((poly) => poly.forEach((ring) => coords.push(...ring)));
        } else if (geometry.type === "GeometryCollection") {
          geometry.geometries.forEach(collect);
        }
      };
      (geojson.features ?? []).forEach((f) => collect(f.geometry));
      if (!coords.length) return;
      const bounds = new mapboxgl.LngLatBounds(coords[0], coords[0]);
      coords.slice(1).forEach((c) => bounds.extend(c));
      map.fitBounds(bounds, { padding: 60, maxZoom: 16, duration: 800 });
    },
    edit() {
      restoreDrawFeatures(draw, currentState);
    },
    blur() {
      // Exit any active draw/edit mode and clear pulse — call this before panel actions
      stopPulse();
      const mode = draw.getMode();
      if (mode !== "simple_select") {
        isBlurring = true;
        try {
          draw.changeMode("simple_select");
        } finally {
          isBlurring = false;
        }
      }
    },
    hasTerrain() {
      return Boolean(map.getSource(TERRAIN_SOURCE_ID));
    },
    getTerrainProvider() {
      // Don't require map.loaded() — that returns false whenever any tile is still
      // fetching (e.g. slow Sentinel-2 tiles), which would block Calculate unfairly.
      // Terrain elevation queries work as long as the source and terrain are set.
      if (!map.getSource(TERRAIN_SOURCE_ID)) return null;
      return new MapboxTerrainProvider((coordinate) => {
        const elevation = map.queryTerrainElevation(coordinate, { exaggerated: false });
        return Number.isFinite(elevation) ? elevation : null;
      });
    },
    async captureImage(projectState = currentState) {
      const previousCamera = snapshotCamera(map);
      const bounds = projectBounds(projectState);
      if (bounds) {
        map.fitBounds(bounds, {
          padding: { top: 90, right: 70, bottom: 70, left: 70 },
          duration: 0,
          maxZoom: 16
        });
      }
      await waitForMapRender(map);
      try {
        return map.getCanvas().toDataURL("image/png");
      } catch {
        return null;
      } finally {
        if (previousCamera) {
          map.jumpTo(previousCamera);
          await waitForMapRender(map);
        }
      }
    }
  };
}

function snapshotCamera(map) {
  const center = map.getCenter();
  return {
    center: [center.lng, center.lat],
    zoom: map.getZoom(),
    bearing: map.getBearing(),
    pitch: map.getPitch()
  };
}

function projectBounds(state) {
  const coordinates = [
    ...(state.skid ? [state.skid] : []),
    ...flattenCoordinates(state.settingPolygon),
    ...(state.skylines ?? []).flatMap((skyline) => skyline.coordinates ?? []),
    ...(state.results ?? []).flatMap((result) => (result.samples ?? []).map((sample) => sample.coordinate).filter(Boolean))
  ].filter(isLngLat);

  if (!coordinates.length) return null;
  const bounds = new mapboxgl.LngLatBounds(coordinates[0], coordinates[0]);
  coordinates.slice(1).forEach((coordinate) => bounds.extend(coordinate));
  return bounds;
}

function flattenCoordinates(coordinates) {
  if (!Array.isArray(coordinates)) return [];
  if (isLngLat(coordinates)) return [coordinates];
  return coordinates.flatMap(flattenCoordinates);
}

function isLngLat(coordinate) {
  return Array.isArray(coordinate)
    && coordinate.length >= 2
    && Number.isFinite(coordinate[0])
    && Number.isFinite(coordinate[1]);
}

function waitForMapRender(map) {
  return new Promise((resolve) => {
    // Wait for the map to finish any in-progress camera movement, then grab
    // two animation frames so the GL canvas has been composited to screen.
    // We deliberately don't gate on map.loaded() or "idle" — those stall
    // indefinitely when background tiles (e.g. Sentinel-2) are still fetching.
    if (map.isMoving()) {
      map.once("moveend", () => {
        map.triggerRepaint();
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      });
    } else {
      map.triggerRepaint();
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    }
  });
}

function addBaseMapLayers(map, linzApiKey, sentinelInstanceId, mode = "outdoors") {
  // Google satellite (hybrid: imagery + road labels baked in)
  if (!map.getSource(SOURCE_IDS.googleSatellite)) {
    map.addSource(SOURCE_IDS.googleSatellite, {
      type: "raster",
      tiles: [
        "https://mt0.google.com/vt/lyrs=y&x={x}&y={y}&z={z}",
        "https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}",
        "https://mt2.google.com/vt/lyrs=y&x={x}&y={y}&z={z}",
        "https://mt3.google.com/vt/lyrs=y&x={x}&y={y}&z={z}"
      ],
      tileSize: 256,
      maxzoom: 20,
      attribution: "© Google"
    });
    map.addLayer({
      id: LAYER_IDS.googleSatellite,
      type: "raster",
      source: SOURCE_IDS.googleSatellite,
      paint: {
        "raster-opacity": mode === "google-satellite" ? 1.0 : 0,
        "raster-opacity-transition": { duration: 250 }
      }
    });
  }

  // Sentinel-2 (Copernicus Data Space WMTS, least-cloudy mosaic of last 3 months)
  if (sentinelInstanceId && !map.getSource(SOURCE_IDS.sentinel2)) {
    const today = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    map.addSource(SOURCE_IDS.sentinel2, {
      type: "raster",
      tiles: [
        `https://sh.dataspace.copernicus.eu/ogc/wmts/${sentinelInstanceId}?SERVICE=WMTS&REQUEST=GetTile&LAYER=TRUE_COLOR&TILEMATRIXSET=PopularWebMercator256&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&MAXCC=5&TIME=${from}/${today}`
      ],
      tileSize: 256,
      maxzoom: 18,
      attribution: "\u00a9 Copernicus/ESA Sentinel-2"
    });
    map.addLayer({
      id: LAYER_IDS.sentinel2,
      type: "raster",
      source: SOURCE_IDS.sentinel2,
      paint: {
        "raster-opacity": mode === "sentinel-2" ? 1.0 : 0,
        "raster-opacity-transition": { duration: 250 }
      }
    });
  }

  // LINZ hillshade
  if (linzApiKey && !map.getSource(SOURCE_IDS.linzHillshade)) {
    map.addSource(SOURCE_IDS.linzHillshade, {
      type: "raster",
      tiles: [`https://basemaps.linz.govt.nz/v1/tiles/hillshade/WebMercatorQuad/{z}/{x}/{y}.png?api=${linzApiKey}`],
      tileSize: 256,
      maxzoom: 21,
      attribution: "© LINZ"
    });
    // In linz-hillshade mode the LINZ tiles ARE the basemap — add below project layers at full opacity.
    // In outdoors mode the layer is hidden (opacity 0) and the Mapbox outdoors style is the basemap.
    const firstSymbolId = mode === "outdoors"
      ? map.getStyle().layers.find((l) => l.type === "symbol")?.id
      : undefined;
    map.addLayer({
      id: LAYER_IDS.linzHillshade,
      type: "raster",
      source: SOURCE_IDS.linzHillshade,
      paint: {
        "raster-opacity": mode === "linz-hillshade" ? 1.0 : 0,
        "raster-opacity-transition": { duration: 250 }
      }
    }, firstSymbolId);
  }
}


function restoreDrawFeatures(draw, state) {
  draw.deleteAll();
  const features = [];
  if (state.skid) features.push({ id: "skid", type: "Feature", properties: { role: "skid" }, geometry: { type: "Point", coordinates: state.skid } });
  if (state.settingPolygon) features.push({ id: "setting", type: "Feature", properties: { role: "setting" }, geometry: { type: "Polygon", coordinates: state.settingPolygon } });
  state.skylines.forEach((skyline, index) => {
    const id = String(index + 1);
    features.push({ id: `skyline-${id}`, type: "Feature", properties: { role: "skyline", skylineId: id }, geometry: { type: "LineString", coordinates: skyline.coordinates } });
  });
  if (features.length) draw.add({ type: "FeatureCollection", features });
}

function readDrawFeatures(draw) {
  const features = draw.getAll().features;
  const point = features.find((feature) => feature.geometry.type === "Point");
  const polygon = features.find((feature) => feature.geometry.type === "Polygon");
  const lines = features.filter((feature) => feature.geometry.type === "LineString");
  return {
    skid: point?.geometry.coordinates ?? null,
    settingPolygon: polygon?.geometry.coordinates ?? null,
    skylines: lines.map((feature, index) => ({
      id: String(index + 1),
      coordinates: feature.geometry.coordinates
    }))
  };
}

function snapLinesToSkid(draw) {
  const collection = draw.getAll();
  const skid = collection.features.find((feature) => feature.geometry.type === "Point")?.geometry.coordinates;
  if (!skid) return false;

  let changed = false;
  const snappedFeatures = collection.features.map((feature) => {
    if (feature.geometry.type !== "LineString" || feature.geometry.coordinates.length < 2) return feature;

    let coordinates = feature.geometry.coordinates.map((coordinate) => [...coordinate]);
    const firstIndex = 0;
    const lastIndex = coordinates.length - 1;
    const snapIndex = distance(coordinates[firstIndex], skid) <= distance(coordinates[lastIndex], skid)
      ? firstIndex
      : lastIndex;

    if (!sameCoordinate(coordinates[snapIndex], skid)) {
      coordinates[snapIndex] = [...skid];
      changed = true;
    }

    if (snapIndex === lastIndex) {
      coordinates = coordinates.reverse();
      changed = true;
    }

    return {
      ...feature,
      geometry: {
        ...feature.geometry,
        coordinates
      }
    };
  });

  if (changed) {
    draw.set({ type: "FeatureCollection", features: snappedFeatures });
  }

  return changed;
}

function sameCoordinate(a, b) {
  return Math.abs(a[0] - b[0]) < 1e-10 && Math.abs(a[1] - b[1]) < 1e-10;
}

function addProjectLayers(map) {
  map.addSource(SOURCE_IDS.setting, { type: "geojson", data: emptyCollection() });
  map.addLayer({
    id: "setting-fill",
    type: "fill",
    source: SOURCE_IDS.setting,
    paint: { "fill-color": "#4f8f42", "fill-opacity": 0.22 }
  });
  // White glow behind the green outline so it reads on any basemap
  map.addLayer({
    id: "setting-outline-glow",
    type: "line",
    source: SOURCE_IDS.setting,
    paint: { "line-color": "#ffffff", "line-width": 6, "line-opacity": 0.7 }
  });
  map.addLayer({
    id: "setting-outline",
    type: "line",
    source: SOURCE_IDS.setting,
    paint: { "line-color": "#1a8f3c", "line-width": 3 }
  });

  map.addSource(SOURCE_IDS.corridors, { type: "geojson", data: emptyCollection() });
  // Wide white glow — visible until results are calculated
  map.addLayer({
    id: "corridor-glow",
    type: "line",
    source: SOURCE_IDS.corridors,
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": "#ffffff",
      "line-opacity": 0.55,
      "line-width": 14,
      "line-blur": 4
    }
  });
  map.addLayer({
    id: "corridor-base",
    type: "line",
    source: SOURCE_IDS.corridors,
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": "#f8c400",
      "line-opacity": 0.95,
      "line-width": 3
    }
  });

  map.addSource(SOURCE_IDS.results, { type: "geojson", data: emptyCollection() });
  map.addLayer({
    id: "result-segments",
    type: "line",
    source: SOURCE_IDS.results,
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-width": 8, "line-color": ["get", "color"], "line-opacity": 0.96 }
  });

  map.addSource(SOURCE_IDS.skid, { type: "geojson", data: emptyCollection() });
  map.addLayer({
    id: "skid-halo",
    type: "circle",
    source: SOURCE_IDS.skid,
    paint: { "circle-radius": 14, "circle-color": "#ffffff", "circle-opacity": 0.9 }
  });
  map.addLayer({
    id: "skid-point",
    type: "circle",
    source: SOURCE_IDS.skid,
    paint: {
      "circle-radius": 8,
      "circle-color": "#111827",
      "circle-stroke-color": "#f8fafc",
      "circle-stroke-width": 3
    }
  });

  map.addSource(SOURCE_IDS.labels, { type: "geojson", data: emptyCollection() });
  map.addLayer({
    id: "skyline-labels",
    type: "symbol",
    source: SOURCE_IDS.labels,
    layout: {
      "text-field": ["get", "label"],
      "text-size": 15,
      "text-font": ["Open Sans Bold", "Arial Unicode MS Bold"],
      "text-allow-overlap": true,
      "text-offset": [0, -1.2]
    },
    paint: {
      "text-color": "#111827",
      "text-halo-color": "#ffffff",
      "text-halo-width": 2
    }
  });

  // GeoTIFF DEM footprint rectangle
  map.addSource(SOURCE_IDS.geotiffFootprint, { type: "geojson", data: emptyCollection() });
  map.addLayer({
    id: "geotiff-footprint-fill",
    type: "fill",
    source: SOURCE_IDS.geotiffFootprint,
    paint: { "fill-color": "#38bdf8", "fill-opacity": 0.08 }
  });
  map.addLayer({
    id: "geotiff-footprint-line",
    type: "line",
    source: SOURCE_IDS.geotiffFootprint,
    paint: {
      "line-color": "#38bdf8",
      "line-width": 2,
      "line-opacity": 0.9,
      "line-dasharray": [4, 3]
    }
  });

  // Pulsing ring rendered behind MapboxDraw's own vertex dots
  map.addSource(SOURCE_IDS.vertexPulse, { type: "geojson", data: emptyCollection() });
  map.addLayer({
    id: "vertex-pulse-ring",
    type: "circle",
    source: SOURCE_IDS.vertexPulse,
    paint: {
      "circle-radius": 8,
      "circle-color": "#1a8f3c",
      "circle-opacity": 0,
      "circle-stroke-color": "#ffffff",
      "circle-stroke-width": 1.5,
      "circle-stroke-opacity": 0
    }
  });
}

function renderProjectMap(map, state) {
  if (!map.getSource(SOURCE_IDS.results)) return;

  // GeoTIFF footprint — show when a DEM is loaded
  if (map.getSource(SOURCE_IDS.geotiffFootprint)) {
    const b = state.geotiffMeta?.boundsLngLat;
    map.getSource(SOURCE_IDS.geotiffFootprint).setData(b ? {
      type: "FeatureCollection",
      features: [{
        type: "Feature",
        properties: {},
        geometry: {
          type: "Polygon",
          coordinates: [[[b.west, b.south], [b.east, b.south], [b.east, b.north], [b.west, b.north], [b.west, b.south]]]
        }
      }]
    } : emptyCollection());
  }

  map.getSource(SOURCE_IDS.setting).setData(state.settingPolygon ? {
    type: "FeatureCollection",
    features: [{ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: state.settingPolygon } }]
  } : emptyCollection());

  map.getSource(SOURCE_IDS.skid).setData(state.skid ? {
    type: "FeatureCollection",
    features: [{ type: "Feature", properties: { label: "Skid" }, geometry: { type: "Point", coordinates: state.skid } }]
  } : emptyCollection());

  map.getSource(SOURCE_IDS.corridors).setData({
    type: "FeatureCollection",
    features: state.skylines.map((skyline, index) => ({
      type: "Feature",
      properties: { label: skyline.id ?? skylineLabel(index) },
      geometry: { type: "LineString", coordinates: skyline.coordinates }
    }))
  });

  // Glow fades away once results are calculated; comes back if results are cleared
  const hasResults = state.results.some((r) => r.samples?.length > 1);
  if (map.getLayer("corridor-glow")) {
    map.setPaintProperty("corridor-glow", "line-opacity", hasResults ? 0 : 0.55);
    map.setPaintProperty("corridor-base", "line-color", hasResults ? COLORS.neutral : "#f8c400");
    map.setPaintProperty("corridor-base", "line-width", hasResults ? 2 : 3);
  }

  map.getSource(SOURCE_IDS.results).setData({
    type: "FeatureCollection",
    features: state.results.flatMap((result) =>
      result.samples.slice(1).map((sample, index) => ({
        type: "Feature",
        properties: {
          color: COLORS[sample.status],
          status: sample.status,
          skylineId: result.id
        },
        geometry: {
          type: "LineString",
          coordinates: [result.samples[index].coordinate, sample.coordinate]
        }
      }))
    )
  });

  const settingArea = polygonAreaSquareMetres(state.settingPolygon);
  const settingCentroid = polygonCentroid(state.settingPolygon);
  const settingLabel = settingCentroid ? [{
    type: "Feature",
    properties: {
      label: `Harvest setting\n${formatArea(settingArea)}`
    },
    geometry: { type: "Point", coordinates: settingCentroid }
  }] : [];

  map.getSource(SOURCE_IDS.labels).setData({
    type: "FeatureCollection",
    features: [
      ...settingLabel,
      ...state.skylines.map((skyline, index) => ({
        type: "Feature",
        properties: { label: skyline.id ?? skylineLabel(index) },
        geometry: { type: "Point", coordinates: labelCoordinate(skyline.coordinates) }
      }))
    ]
  });
}

function emptyCollection() {
  return { type: "FeatureCollection", features: [] };
}

function addParcelLayer(map) {
  if (map.getSource(SOURCE_IDS.linzParcels)) return;
  map.addSource(SOURCE_IDS.linzParcels, {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] }
  });
  map.addLayer({
    id: LAYER_IDS.linzParcelsFill,
    type: "fill",
    source: SOURCE_IDS.linzParcels,
    minzoom: 13,
    paint: { "fill-color": "#f59e0b", "fill-opacity": 0.05 }
  });
  map.addLayer({
    id: LAYER_IDS.linzParcelsLine,
    type: "line",
    source: SOURCE_IDS.linzParcels,
    minzoom: 13,
    paint: { "line-color": "#92400e", "line-width": 0.8, "line-opacity": 0.7 }
  });
  map.addLayer({
    id: LAYER_IDS.linzParcelsLabel,
    type: "symbol",
    source: SOURCE_IDS.linzParcels,
    minzoom: 15,
    layout: {
      "text-field": ["get", "appellation"],
      "text-size": 10,
      "text-font": ["Open Sans Regular", "Arial Unicode MS Regular"],
      "text-allow-overlap": false,
      "text-max-width": 8
    },
    paint: {
      "text-color": "#78350f",
      "text-halo-color": "rgba(255,255,255,0.8)",
      "text-halo-width": 1.5
    }
  });
}

function fetchParcels(map, ldsKey) {
  if (!ldsKey || !map.getSource(SOURCE_IDS.linzParcels)) return;
  if (map.getZoom() < 13) return;
  const bounds = map.getBounds();
  const bbox = [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()].join(",");
  const url = `https://data.linz.govt.nz/services;key=${ldsKey}/wfs`
    + `?service=WFS&version=2.0.0&request=GetFeature`
    + `&typeNames=layer-50772&outputFormat=application/json`
    + `&bbox=${bbox},EPSG:4326`;
  fetch(url)
    .then((r) => r.json())
    .then((data) => {
      if (map.getSource(SOURCE_IDS.linzParcels)) {
        map.getSource(SOURCE_IDS.linzParcels).setData(data);
      }
    })
    .catch(() => {});
}

function addTerrainSource(map) {
  if (map.getSource(TERRAIN_SOURCE_ID)) return;
  map.addSource(TERRAIN_SOURCE_ID, {
    type: "raster-dem",
    url: "mapbox://mapbox.mapbox-terrain-dem-v1",
    tileSize: 512,
    maxzoom: 14
  });
  map.setTerrain({ source: TERRAIN_SOURCE_ID, exaggeration: 1 });
}

function createFallbackMap(container, state, onGeometryChange) {
  container.innerHTML = `
    <div class="fallback-map">
      <div class="map-legend">
        <span><i class="legend-green"></i> Clearance</span>
        <span><i class="legend-red"></i> No lift</span>
        <span><i class="legend-skid"></i> Skid</span>
      </div>
      <p>Mapbox token not set. The prototype is running in no-map mode.</p>
      <button data-demo>Load demo geometry</button>
    </div>
  `;
  container.querySelector("[data-demo]").addEventListener("click", () => {
    onGeometryChange({
      skid: [0, 0],
      settingPolygon: [[[0, 0], [0.008, 0.002], [0.01, 0.011], [0.001, 0.012], [0, 0]]],
      skylines: [
        { id: "skyline-1", coordinates: [[0, 0], [0.006, 0.008]] },
        { id: "skyline-2", coordinates: [[0, 0], [0.009, 0.004]] }
      ]
    });
  });
  return {
    render(nextState) {
      state = nextState;
    },
    syncDraw(nextState) {
      state = nextState;
    },
    edit() {},
    hasTerrain() {
      return false;
    },
    getTerrainProvider() {
      return null;
    },
    async captureImage() {
      return null;
    }
  };
}

function addLegend(container) {
  const legend = document.createElement("div");
  legend.className = "map-legend";
  legend.innerHTML = `
    <span><i class="legend-green"></i> Clearance</span>
    <span><i class="legend-red"></i> Below minimum / no lift</span>
    <span><i class="legend-setting"></i> Setting</span>
    <span><i class="legend-skid"></i> Skid</span>
  `;
  container.appendChild(legend);
}

function renameDrawControls(container) {
  window.requestAnimationFrame(() => {
    const labels = [
      [".mapbox-gl-draw_point", "Add skid"],
      [".mapbox-gl-draw_line", "Draw skyline corridor"],
      [".mapbox-gl-draw_polygon", "Draw harvest setting"],
      [".mapbox-gl-draw_trash", "Delete selected drawing"]
    ];

    labels.forEach(([selector, label]) => {
      const button = container.querySelector(selector);
      if (!button) return;
      button.title = label;
      button.setAttribute("aria-label", label);
    });
  });
}

function skylineLabel(index) {
  return String(index + 1);
}

function labelCoordinate(coordinates) {
  if (!coordinates?.length) return [0, 0];
  const index = Math.max(0, Math.floor((coordinates.length - 1) / 2));
  const start = coordinates[index];
  const end = coordinates[index + 1] ?? start;
  return [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2];
}
